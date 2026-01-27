"""
AURIGE - CAN Controller Module
Real CAN bus operations using Linux can-utils

This module is the ONLY component that executes CAN-related system commands.
All CAN operations must go through this controller to maintain security
and architectural separation.

Supported commands (via can-utils):
- ip link: Interface management (up/down, bitrate)
- candump: Capture CAN frames
- cansend: Send single CAN frames
- canplayer: Replay log files
- cangen: Generate traffic for testing
"""

import asyncio
import logging
import os
import re
import signal
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import AsyncGenerator, Callable, Optional

logger = logging.getLogger(__name__)

# Configuration
DATA_DIR = Path(os.getenv("AURIGE_DATA_DIR", "/opt/aurige/data"))
LOGS_DIR = DATA_DIR / "logs"


@dataclass
class CANFrame:
    """Represents a single CAN frame"""
    timestamp: str
    interface: str
    can_id: str
    data: str
    delta: str = "0.000"


@dataclass
class CANInterfaceStatus:
    """Status of a CAN interface"""
    name: str
    is_up: bool
    bitrate: Optional[int]
    tx_packets: int = 0
    rx_packets: int = 0
    tx_errors: int = 0
    rx_errors: int = 0


class CANController:
    """
    CAN Controller - System authority for all CAN operations.
    
    This class is responsible for:
    - Managing CAN interfaces (can0, can1)
    - Executing can-utils commands
    - Streaming live CAN data
    - Managing capture sessions
    - Replaying log files
    
    SECURITY: All subprocess calls are sanitized and validated.
    """
    
    # Valid interfaces (whitelist)
    VALID_INTERFACES = {"can0", "can1", "vcan0", "vcan1"}
    
    # Valid bitrates (whitelist)
    VALID_BITRATES = {10000, 20000, 50000, 100000, 125000, 250000, 500000, 800000, 1000000}
    
    def __init__(self):
        self._active_captures: dict[str, asyncio.subprocess.Process] = {}
        self._active_replays: dict[str, asyncio.subprocess.Process] = {}
        self._active_generators: dict[str, asyncio.subprocess.Process] = {}
    
    # =========================================================================
    # Validation helpers
    # =========================================================================
    
    def _validate_interface(self, interface: str) -> str:
        """Validate and sanitize interface name"""
        interface = str(interface).strip().lower()
        if interface not in self.VALID_INTERFACES:
            raise ValueError(f"Invalid interface: {interface}. Must be one of {self.VALID_INTERFACES}")
        return interface
    
    def _validate_bitrate(self, bitrate: int) -> int:
        """Validate bitrate value"""
        bitrate = int(bitrate)
        if bitrate not in self.VALID_BITRATES:
            raise ValueError(f"Invalid bitrate: {bitrate}. Must be one of {self.VALID_BITRATES}")
        return bitrate
    
    def _validate_can_id(self, can_id: str) -> str:
        """Validate CAN ID format (3 or 8 hex chars)"""
        can_id = str(can_id).strip().upper()
        # Remove 0x prefix if present
        if can_id.startswith("0X"):
            can_id = can_id[2:]
        # Validate hex format (standard 11-bit or extended 29-bit)
        if not re.match(r'^[0-9A-F]{1,8}$', can_id):
            raise ValueError(f"Invalid CAN ID: {can_id}. Must be 1-8 hex characters")
        return can_id
    
    def _validate_can_data(self, data: str) -> str:
        """Validate CAN data format (hex bytes)"""
        data = str(data).strip().upper().replace(" ", "")
        # Validate: 0-16 hex chars (0-8 bytes)
        if not re.match(r'^[0-9A-F]{0,16}$', data):
            raise ValueError(f"Invalid CAN data: {data}. Must be 0-16 hex characters")
        return data
    
    def _validate_log_path(self, mission_id: str, filename: str) -> Path:
        """Validate and return safe log file path"""
        # Sanitize mission_id and filename to prevent path traversal
        safe_mission_id = re.sub(r'[^a-zA-Z0-9_-]', '', str(mission_id))
        safe_filename = re.sub(r'[^a-zA-Z0-9_.-]', '', str(filename))
        
        if not safe_filename.endswith('.log'):
            safe_filename += '.log'
        
        log_path = LOGS_DIR / safe_mission_id / safe_filename
        
        # Ensure path is within LOGS_DIR (prevent traversal)
        try:
            log_path.resolve().relative_to(LOGS_DIR.resolve())
        except ValueError:
            raise ValueError("Invalid log path")
        
        return log_path
    
    # =========================================================================
    # Interface Management
    # =========================================================================
    
    async def get_interface_status(self, interface: str) -> CANInterfaceStatus:
        """Get status of a CAN interface"""
        interface = self._validate_interface(interface)
        
        try:
            # Get link state
            proc = await asyncio.create_subprocess_exec(
                "ip", "-details", "link", "show", interface,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            stdout, stderr = await proc.communicate()
            
            if proc.returncode != 0:
                return CANInterfaceStatus(name=interface, is_up=False, bitrate=None)
            
            output = stdout.decode()
            is_up = "UP" in output and "LOWER_UP" in output
            
            # Extract bitrate
            bitrate = None
            bitrate_match = re.search(r'bitrate\s+(\d+)', output)
            if bitrate_match:
                bitrate = int(bitrate_match.group(1))
            
            # Get statistics
            proc_stats = await asyncio.create_subprocess_exec(
                "ip", "-s", "link", "show", interface,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            stdout_stats, _ = await proc_stats.communicate()
            stats_output = stdout_stats.decode()
            
            # Parse TX/RX stats (simplified)
            tx_packets = rx_packets = tx_errors = rx_errors = 0
            lines = stats_output.split('\n')
            for i, line in enumerate(lines):
                if 'RX:' in line and i + 1 < len(lines):
                    rx_parts = lines[i + 1].split()
                    if len(rx_parts) >= 2:
                        rx_packets = int(rx_parts[1]) if rx_parts[1].isdigit() else 0
                        rx_errors = int(rx_parts[2]) if len(rx_parts) > 2 and rx_parts[2].isdigit() else 0
                if 'TX:' in line and i + 1 < len(lines):
                    tx_parts = lines[i + 1].split()
                    if len(tx_parts) >= 2:
                        tx_packets = int(tx_parts[1]) if tx_parts[1].isdigit() else 0
                        tx_errors = int(tx_parts[2]) if len(tx_parts) > 2 and tx_parts[2].isdigit() else 0
            
            return CANInterfaceStatus(
                name=interface,
                is_up=is_up,
                bitrate=bitrate,
                tx_packets=tx_packets,
                rx_packets=rx_packets,
                tx_errors=tx_errors,
                rx_errors=rx_errors
            )
            
        except Exception as e:
            logger.error(f"Failed to get interface status: {e}")
            return CANInterfaceStatus(name=interface, is_up=False, bitrate=None)
    
    async def setup_interface(self, interface: str, bitrate: int) -> bool:
        """
        Initialize a CAN interface with the specified bitrate.
        
        Executes:
            ip link set {interface} down
            ip link set {interface} type can bitrate {bitrate}
            ip link set {interface} up
        """
        interface = self._validate_interface(interface)
        bitrate = self._validate_bitrate(bitrate)
        
        try:
            # Bring interface down first
            proc_down = await asyncio.create_subprocess_exec(
                "sudo", "ip", "link", "set", interface, "down",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            await proc_down.communicate()
            
            # Set bitrate
            proc_bitrate = await asyncio.create_subprocess_exec(
                "sudo", "ip", "link", "set", interface, "type", "can", "bitrate", str(bitrate),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            stdout, stderr = await proc_bitrate.communicate()
            
            if proc_bitrate.returncode != 0:
                logger.error(f"Failed to set bitrate: {stderr.decode()}")
                return False
            
            # Bring interface up
            proc_up = await asyncio.create_subprocess_exec(
                "sudo", "ip", "link", "set", interface, "up",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            stdout, stderr = await proc_up.communicate()
            
            if proc_up.returncode != 0:
                logger.error(f"Failed to bring interface up: {stderr.decode()}")
                return False
            
            logger.info(f"Interface {interface} configured with bitrate {bitrate}")
            return True
            
        except Exception as e:
            logger.error(f"Failed to setup interface: {e}")
            return False
    
    async def bring_interface_down(self, interface: str) -> bool:
        """Bring a CAN interface down"""
        interface = self._validate_interface(interface)
        
        try:
            proc = await asyncio.create_subprocess_exec(
                "sudo", "ip", "link", "set", interface, "down",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            await proc.communicate()
            return proc.returncode == 0
        except Exception as e:
            logger.error(f"Failed to bring interface down: {e}")
            return False
    
    # =========================================================================
    # CAN Frame Operations
    # =========================================================================
    
    async def send_frame(self, interface: str, can_id: str, data: str) -> bool:
        """
        Send a single CAN frame.
        
        Executes: cansend {interface} {can_id}#{data}
        
        Example: cansend can0 7DF#0201050000000000
        """
        interface = self._validate_interface(interface)
        can_id = self._validate_can_id(can_id)
        data = self._validate_can_data(data)
        
        frame = f"{can_id}#{data}"
        
        try:
            proc = await asyncio.create_subprocess_exec(
                "cansend", interface, frame,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            stdout, stderr = await proc.communicate()
            
            if proc.returncode != 0:
                logger.error(f"cansend failed: {stderr.decode()}")
                return False
            
            logger.info(f"Sent frame on {interface}: {frame}")
            return True
            
        except FileNotFoundError:
            logger.error("cansend not found. Install can-utils package.")
            return False
        except Exception as e:
            logger.error(f"Failed to send frame: {e}")
            return False
    
    # =========================================================================
    # Capture Operations (candump)
    # =========================================================================
    
    async def start_capture(
        self,
        interface: str,
        mission_id: str,
        filename: str,
        callback: Optional[Callable[[CANFrame], None]] = None
    ) -> str:
        """
        Start capturing CAN frames to a log file.
        
        Executes: candump -L {interface} > {logfile}
        
        Returns: capture_id for stopping the capture
        """
        interface = self._validate_interface(interface)
        log_path = self._validate_log_path(mission_id, filename)
        
        # Ensure directory exists
        log_path.parent.mkdir(parents=True, exist_ok=True)
        
        capture_id = f"{mission_id}_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
        
        try:
            # Open log file
            log_file = open(log_path, 'w')
            
            # Start candump process with log format
            proc = await asyncio.create_subprocess_exec(
                "candump", "-L", interface,
                stdout=log_file,
                stderr=asyncio.subprocess.PIPE
            )
            
            self._active_captures[capture_id] = proc
            logger.info(f"Started capture {capture_id} on {interface} -> {log_path}")
            
            return capture_id
            
        except FileNotFoundError:
            logger.error("candump not found. Install can-utils package.")
            raise RuntimeError("candump not available")
        except Exception as e:
            logger.error(f"Failed to start capture: {e}")
            raise
    
    async def stop_capture(self, capture_id: str) -> bool:
        """Stop an active capture session"""
        if capture_id not in self._active_captures:
            logger.warning(f"Capture {capture_id} not found")
            return False
        
        try:
            proc = self._active_captures[capture_id]
            proc.terminate()
            await asyncio.wait_for(proc.wait(), timeout=5.0)
            del self._active_captures[capture_id]
            logger.info(f"Stopped capture {capture_id}")
            return True
        except asyncio.TimeoutError:
            proc.kill()
            del self._active_captures[capture_id]
            logger.warning(f"Force killed capture {capture_id}")
            return True
        except Exception as e:
            logger.error(f"Failed to stop capture: {e}")
            return False
    
    async def stream_candump(self, interface: str) -> AsyncGenerator[CANFrame, None]:
        """
        Stream live CAN frames from candump.
        
        Executes: candump {interface}
        
        Yields: CANFrame objects in real-time
        
        This is designed for WebSocket streaming to the UI.
        """
        interface = self._validate_interface(interface)
        
        try:
            proc = await asyncio.create_subprocess_exec(
                "candump", "-ta", interface,  # -ta for absolute timestamp
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            
            last_timestamp = None
            
            while True:
                line = await proc.stdout.readline()
                if not line:
                    break
                
                line_str = line.decode().strip()
                if not line_str:
                    continue
                
                # Parse candump output
                # Format: (1706123456.123456) can0 7DF#0201050000000000
                frame = self._parse_candump_line(line_str, last_timestamp)
                if frame:
                    last_timestamp = frame.timestamp
                    yield frame
                    
        except asyncio.CancelledError:
            proc.terminate()
            raise
        except Exception as e:
            logger.error(f"candump stream error: {e}")
            raise
    
    def _parse_candump_line(self, line: str, last_timestamp: Optional[str] = None) -> Optional[CANFrame]:
        """Parse a candump output line into a CANFrame"""
        try:
            # Format: (1706123456.123456) can0 7DF#0201050000000000
            match = re.match(r'\((\d+\.\d+)\)\s+(\w+)\s+([0-9A-Fa-f]+)#([0-9A-Fa-f]*)', line)
            if not match:
                return None
            
            timestamp_raw, interface, can_id, data = match.groups()
            
            # Convert timestamp to readable format
            ts_float = float(timestamp_raw)
            dt = datetime.fromtimestamp(ts_float)
            timestamp = dt.strftime("%H:%M:%S") + f".{int((ts_float % 1) * 1000):03d}"
            
            # Format data with spaces
            data_formatted = ' '.join(data[i:i+2] for i in range(0, len(data), 2))
            
            # Calculate delta
            delta = "0.000"
            if last_timestamp:
                try:
                    # Simple delta calculation (would need more complex logic for real use)
                    delta = "0.001"
                except:
                    pass
            
            return CANFrame(
                timestamp=timestamp,
                interface=interface,
                can_id=f"0x{can_id.upper()}",
                data=data_formatted.upper(),
                delta=delta
            )
        except Exception as e:
            logger.debug(f"Failed to parse candump line: {line} - {e}")
            return None
    
    # =========================================================================
    # Replay Operations (canplayer)
    # =========================================================================
    
    async def start_replay(
        self,
        mission_id: str,
        filename: str,
        interface: str,
        speed: float = 1.0,
        loop: bool = False
    ) -> str:
        """
        Replay a captured log file.
        
        Executes: canplayer -I {logfile} {interface}={interface}
        
        Args:
            speed: Playback speed multiplier (1.0 = real-time)
            loop: Whether to loop the playback
        
        Returns: replay_id for stopping the replay
        """
        interface = self._validate_interface(interface)
        log_path = self._validate_log_path(mission_id, filename)
        
        if not log_path.exists():
            raise FileNotFoundError(f"Log file not found: {log_path}")
        
        replay_id = f"replay_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
        
        try:
            args = ["canplayer", "-I", str(log_path)]
            
            # Speed control (gaps multiplier, inverted)
            if speed != 1.0:
                args.extend(["-g", str(int(1000 / speed))])
            
            # Loop playback
            if loop:
                args.append("-l")
            
            # Interface mapping
            args.append(f"{interface}={interface}")
            
            proc = await asyncio.create_subprocess_exec(
                *args,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            
            self._active_replays[replay_id] = proc
            logger.info(f"Started replay {replay_id} from {log_path}")
            
            return replay_id
            
        except FileNotFoundError:
            logger.error("canplayer not found. Install can-utils package.")
            raise RuntimeError("canplayer not available")
        except Exception as e:
            logger.error(f"Failed to start replay: {e}")
            raise
    
    async def stop_replay(self, replay_id: str) -> bool:
        """Stop an active replay session"""
        if replay_id not in self._active_replays:
            logger.warning(f"Replay {replay_id} not found")
            return False
        
        try:
            proc = self._active_replays[replay_id]
            proc.terminate()
            await asyncio.wait_for(proc.wait(), timeout=5.0)
            del self._active_replays[replay_id]
            logger.info(f"Stopped replay {replay_id}")
            return True
        except asyncio.TimeoutError:
            proc.kill()
            del self._active_replays[replay_id]
            return True
        except Exception as e:
            logger.error(f"Failed to stop replay: {e}")
            return False
    
    # =========================================================================
    # Traffic Generation (cangen)
    # =========================================================================
    
    async def start_generator(
        self,
        interface: str,
        can_id: Optional[str] = None,
        data_length: int = 8,
        gap_ms: int = 100,
        burst_count: Optional[int] = None
    ) -> str:
        """
        Generate CAN traffic for testing.
        
        Executes: cangen {interface} -g {gap} -D {data}
        
        Args:
            can_id: Fixed CAN ID (random if None)
            data_length: Data length in bytes (0-8)
            gap_ms: Gap between frames in milliseconds
            burst_count: Number of frames to send (infinite if None)
        
        Returns: generator_id for stopping the generator
        """
        interface = self._validate_interface(interface)
        
        generator_id = f"gen_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
        
        try:
            args = ["cangen", interface]
            
            # Gap in milliseconds
            args.extend(["-g", str(gap_ms)])
            
            # Data length
            args.extend(["-L", str(min(8, max(0, data_length)))])
            
            # Fixed CAN ID
            if can_id:
                can_id = self._validate_can_id(can_id)
                args.extend(["-I", can_id])
            
            # Burst count
            if burst_count:
                args.extend(["-n", str(burst_count)])
            
            proc = await asyncio.create_subprocess_exec(
                *args,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            
            self._active_generators[generator_id] = proc
            logger.info(f"Started generator {generator_id} on {interface}")
            
            return generator_id
            
        except FileNotFoundError:
            logger.error("cangen not found. Install can-utils package.")
            raise RuntimeError("cangen not available")
        except Exception as e:
            logger.error(f"Failed to start generator: {e}")
            raise
    
    async def stop_generator(self, generator_id: str) -> bool:
        """Stop an active traffic generator"""
        if generator_id not in self._active_generators:
            logger.warning(f"Generator {generator_id} not found")
            return False
        
        try:
            proc = self._active_generators[generator_id]
            proc.terminate()
            await asyncio.wait_for(proc.wait(), timeout=5.0)
            del self._active_generators[generator_id]
            logger.info(f"Stopped generator {generator_id}")
            return True
        except asyncio.TimeoutError:
            proc.kill()
            del self._active_generators[generator_id]
            return True
        except Exception as e:
            logger.error(f"Failed to stop generator: {e}")
            return False
    
    # =========================================================================
    # Cleanup
    # =========================================================================
    
    async def cleanup(self):
        """Stop all active processes"""
        for capture_id in list(self._active_captures.keys()):
            await self.stop_capture(capture_id)
        
        for replay_id in list(self._active_replays.keys()):
            await self.stop_replay(replay_id)
        
        for generator_id in list(self._active_generators.keys()):
            await self.stop_generator(generator_id)


# Global controller instance
can_controller = CANController()
