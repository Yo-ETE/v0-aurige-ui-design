"""
DBC file parser for importing official CAN database files.
Supports Vector .dbc format with messages, signals, ECUs, and value tables.
"""
import re
from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass

@dataclass
class DBCSignal:
    name: str
    bit_start: int
    bit_length: int
    byte_order: str  # "little" or "big"
    value_type: str  # "signed" or "unsigned"
    factor: float
    offset: float
    minimum: float
    maximum: float
    unit: str
    receivers: List[str]
    comment: str = ""
    value_table: Dict[int, str] = None

@dataclass
class DBCMessage:
    can_id: int
    name: str
    dlc: int
    sender: str
    signals: List[DBCSignal]
    comment: str = ""

@dataclass
class DBCDatabase:
    messages: List[DBCMessage]
    ecus: List[str]
    version: str = ""

class DBCParser:
    """Parser for Vector .dbc files."""
    
    def __init__(self):
        self.messages: Dict[int, DBCMessage] = {}
        self.ecus: List[str] = []
        self.value_tables: Dict[str, Dict[int, str]] = {}
        self.comments: Dict[Tuple[str, str], str] = {}  # (type, identifier) -> comment
        
    def parse_file(self, file_path: str) -> DBCDatabase:
        """Parse a .dbc file and return structured database."""
        with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
            content = f.read()
        
        return self.parse_content(content)
    
    def parse_content(self, content: str) -> DBCDatabase:
        """Parse DBC content string."""
        lines = content.split('\n')
        
        # Parse ECUs (BU_)
        self._parse_ecus(lines)
        
        # Parse value tables (VAL_TABLE_)
        self._parse_value_tables(lines)
        
        # Parse messages and signals (BO_ and SG_)
        self._parse_messages(lines)
        
        # Parse comments (CM_)
        self._parse_comments(lines)
        
        # Parse signal value descriptions (VAL_)
        self._parse_signal_values(lines)
        
        # Apply comments to messages and signals
        self._apply_comments()
        
        return DBCDatabase(
            messages=list(self.messages.values()),
            ecus=self.ecus,
            version=self._extract_version(lines)
        )
    
    def _parse_ecus(self, lines: List[str]):
        """Parse ECU nodes (BU_: ECU1 ECU2 ...)."""
        for line in lines:
            match = re.match(r'^BU_:\s*(.*)', line)
            if match:
                ecus = match.group(1).strip().split()
                self.ecus = ecus
                break
    
    def _parse_value_tables(self, lines: List[str]):
        """Parse value tables (VAL_TABLE_ TableName 0 "Value0" 1 "Value1" ;)."""
        for line in lines:
            match = re.match(r'^VAL_TABLE_\s+(\w+)\s+(.*?)\s*;', line)
            if match:
                table_name = match.group(1)
                values_str = match.group(2)
                
                # Parse value pairs: 0 "Off" 1 "On"
                value_pattern = r'(\d+)\s+"([^"]*)"'
                values = {int(num): desc for num, desc in re.findall(value_pattern, values_str)}
                self.value_tables[table_name] = values
    
    def _parse_messages(self, lines: List[str]):
        """Parse messages (BO_) and their signals (SG_)."""
        i = 0
        while i < len(lines):
            line = lines[i].strip()
            
            # Match: BO_ 500 SpeedData: 8 ECU1
            msg_match = re.match(r'^BO_\s+(\d+)\s+(\w+):\s+(\d+)\s+(\w+)', line)
            if msg_match:
                can_id = int(msg_match.group(1))
                name = msg_match.group(2)
                dlc = int(msg_match.group(3))
                sender = msg_match.group(4)
                
                message = DBCMessage(
                    can_id=can_id,
                    name=name,
                    dlc=dlc,
                    sender=sender,
                    signals=[]
                )
                
                # Parse signals for this message
                i += 1
                while i < len(lines):
                    signal_line = lines[i].strip()
                    
                    # Match: SG_ Speed : 0|16@1+ (0.01,0) [0|655.35] "km/h" ECU2,ECU3
                    sig_match = re.match(
                        r'^SG_\s+(\w+)\s*:\s*(\d+)\|(\d+)@([01])([+-])\s*'
                        r'\(([^,]+),([^)]+)\)\s*\[([^|]+)\|([^\]]+)\]\s*"([^"]*)"\s*(.*)',
                        signal_line
                    )
                    
                    if sig_match:
                        signal_name = sig_match.group(1)
                        bit_start = int(sig_match.group(2))
                        bit_length = int(sig_match.group(3))
                        byte_order = "little" if sig_match.group(4) == "1" else "big"
                        value_type = "signed" if sig_match.group(5) == "-" else "unsigned"
                        factor = float(sig_match.group(6))
                        offset = float(sig_match.group(7))
                        minimum = float(sig_match.group(8))
                        maximum = float(sig_match.group(9))
                        unit = sig_match.group(10)
                        receivers_str = sig_match.group(11).strip()
                        receivers = [r.strip() for r in receivers_str.split(',')] if receivers_str else []
                        
                        signal = DBCSignal(
                            name=signal_name,
                            bit_start=bit_start,
                            bit_length=bit_length,
                            byte_order=byte_order,
                            value_type=value_type,
                            factor=factor,
                            offset=offset,
                            minimum=minimum,
                            maximum=maximum,
                            unit=unit,
                            receivers=receivers
                        )
                        
                        message.signals.append(signal)
                        i += 1
                    else:
                        # End of signals for this message
                        break
                
                self.messages[can_id] = message
                continue
            
            i += 1
    
    def _parse_comments(self, lines: List[str]):
        """Parse comments (CM_ SG_ 500 Speed "Description";)."""
        for line in lines:
            # Signal comment: CM_ SG_ 500 Speed "Description";
            match = re.match(r'^CM_\s+SG_\s+(\d+)\s+(\w+)\s+"([^"]*)"\s*;', line)
            if match:
                can_id = int(match.group(1))
                signal_name = match.group(2)
                comment = match.group(3)
                self.comments[("signal", f"{can_id}_{signal_name}")] = comment
                continue
            
            # Message comment: CM_ BO_ 500 "Message description";
            match = re.match(r'^CM_\s+BO_\s+(\d+)\s+"([^"]*)"\s*;', line)
            if match:
                can_id = int(match.group(1))
                comment = match.group(2)
                self.comments[("message", str(can_id))] = comment
    
    def _parse_signal_values(self, lines: List[str]):
        """Parse signal value descriptions (VAL_ 500 Speed 0 "Stop" 1 "Moving" ;)."""
        for line in lines:
            match = re.match(r'^VAL_\s+(\d+)\s+(\w+)\s+(.*?)\s*;', line)
            if match:
                can_id = int(match.group(1))
                signal_name = match.group(2)
                values_str = match.group(3)
                
                # Parse value pairs
                value_pattern = r'(\d+)\s+"([^"]*)"'
                values = {int(num): desc for num, desc in re.findall(value_pattern, values_str)}
                
                # Find signal and attach value table
                if can_id in self.messages:
                    for signal in self.messages[can_id].signals:
                        if signal.name == signal_name:
                            signal.value_table = values
    
    def _apply_comments(self):
        """Apply parsed comments to messages and signals."""
        for (comment_type, identifier), comment in self.comments.items():
            if comment_type == "message":
                can_id = int(identifier)
                if can_id in self.messages:
                    self.messages[can_id].comment = comment
            
            elif comment_type == "signal":
                can_id_str, signal_name = identifier.split('_', 1)
                can_id = int(can_id_str)
                if can_id in self.messages:
                    for signal in self.messages[can_id].signals:
                        if signal.name == signal_name:
                            signal.comment = comment
    
    def _extract_version(self, lines: List[str]) -> str:
        """Extract VERSION string."""
        for line in lines:
            match = re.match(r'^VERSION\s+"([^"]*)"', line)
            if match:
                return match.group(1)
        return ""


def parse_dbc_file(content: str) -> dict:
    """
    Parse DBC content string and return a dict with messages, ecus, version.
    Each message contains its signals with all attributes.
    """
    parser = DBCParser()
    db = parser.parse_content(content)

    messages = []
    for msg in db.messages:
        signals = []
        for sig in msg.signals:
            signals.append({
                "name": sig.name,
                "start_bit": sig.bit_start,
                "bit_length": sig.bit_length,
                "byte_order": sig.byte_order,
                "value_type": sig.value_type,
                "factor": sig.factor,
                "offset": sig.offset,
                "min": sig.minimum,
                "max": sig.maximum,
                "unit": sig.unit,
                "receivers": sig.receivers,
                "comment": sig.comment,
                "value_table": sig.value_table or {},
            })
        messages.append({
            "id": "{:03X}".format(msg.can_id),
            "name": msg.name,
            "dlc": msg.dlc,
            "sender": msg.sender,
            "comment": msg.comment,
            "signals": signals,
        })

    return {
        "messages": messages,
        "ecus": db.ecus,
        "version": db.version,
    }
