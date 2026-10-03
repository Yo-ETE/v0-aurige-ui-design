"""AURIGE - Domaine reseau (Wi-Fi, Ethernet, hotspot). Extrait de main.py, routes inchangees."""
import asyncio
import json
import time

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import hotspot
import main

router = APIRouter()


class WifiConnectRequest(BaseModel):
    ssid: str
    password: str


class HotspotPassword(BaseModel):
    password: str


@router.get("/api/network/wifi/scan")
async def scan_wifi_networks():
    """Scan for available Wi-Fi networks"""
    try:
        # Use nmcli to scan for networks.
        # --rescan yes force un scan radio frais : il peut dépasser 10s (radio
        # occupée, nombreux APs). Timeout porté à 30s pour éviter le 504.
        result = main.run_command(["nmcli", "-t", "-f", "SSID,SIGNAL,SECURITY,BSSID", "device", "wifi", "list", "--rescan", "yes"], check=False, timeout=30)
        if result.returncode != 0:
            return {"status": "error", "message": "Failed to scan Wi-Fi networks", "networks": []}
        
        networks = []
        seen_ssids = set()
        for line in result.stdout.strip().split("\n"):
            if not line:
                continue
            parts = line.split(":")
            if len(parts) >= 4:
                ssid = parts[0]
                if ssid and ssid not in seen_ssids:
                    seen_ssids.add(ssid)
                    networks.append({
                        "ssid": ssid,
                        "signal": int(parts[1]) if parts[1].isdigit() else 0,
                        "security": parts[2] if parts[2] else "Open",
                        "bssid": parts[3] if len(parts) > 3 else "",
                    })
        
        # Sort by signal strength
        networks.sort(key=lambda x: x["signal"], reverse=True)
        return {"status": "success", "networks": networks}
    except Exception as e:
        return {"status": "error", "message": str(e), "networks": []}


@router.get("/api/network/wifi/status")
async def get_wifi_status():
    """Get current Wi-Fi connection status with detailed info"""
    try:
        # Check if wlan0 is in AP (hotspot) mode or client mode
        # AP mode typically has IP 10.42.0.1
        is_hotspot = False
        hotspot_ssid = ""
        client_ssid = ""
        client_signal = 0
        tx_rate = ""
        rx_rate = ""
        ip_local = ""
        
        # Check wlan0 IP
        ip_result = main.run_command(["ip", "-4", "addr", "show", "wlan0"], check=False)
        for line in ip_result.stdout.split("\n"):
            if "inet " in line:
                ip_local = line.strip().split()[1].split("/")[0]
                # 10.42.0.1 is the typical hotspot IP
                if ip_local.startswith("10.42.0."):
                    is_hotspot = True
                break
        
        # Check nmcli for connection info
        nmcli_result = main.run_command(["nmcli", "-t", "-f", "NAME,TYPE,DEVICE", "connection", "show", "--active"], check=False)
        for line in nmcli_result.stdout.strip().split("\n"):
            parts = line.split(":")
            if len(parts) >= 3:
                conn_name, conn_type, device = parts[0], parts[1], parts[2]
                if device == "wlan0":
                    if conn_type == "802-11-wireless" or "wifi" in conn_type.lower():
                        # Check if this is AP or client
                        # AP connections typically have "Hotspot" in name or we can check mode
                        mode_result = main.run_command(["nmcli", "-t", "-f", "802-11-wireless.mode", "connection", "show", conn_name], check=False)
                        mode = mode_result.stdout.strip().split(":")[-1] if mode_result.returncode == 0 else ""
                        if mode == "ap" or "hotspot" in conn_name.lower() or "aurige" in conn_name.lower():
                            is_hotspot = True
                            # Get actual SSID from connection settings (not connection name)
                            ssid_r = main.run_command(["nmcli", "-t", "-f", "802-11-wireless.ssid", "connection", "show", conn_name], check=False)
                            if ssid_r.returncode == 0:
                                ssid_line = ssid_r.stdout.strip()
                                hotspot_ssid = ssid_line.split(":")[-1] if ":" in ssid_line else conn_name
                            else:
                                hotspot_ssid = conn_name
                        else:
                            client_ssid = conn_name
        
        # If in client mode, get actual SSID and signal
        if not is_hotspot and ip_local:
            # Try iwgetid for SSID
            ssid_result = main.run_command(["iwgetid", "-r", "wlan0"], check=False)
            if ssid_result.returncode == 0 and ssid_result.stdout.strip():
                client_ssid = ssid_result.stdout.strip()
            
            # Get signal and rates from iw
            iw_result = main.run_command(["iw", "dev", "wlan0", "link"], check=False)
            for line in iw_result.stdout.split("\n"):
                if "SSID:" in line and not client_ssid:
                    client_ssid = line.split("SSID:")[1].strip()
                if "signal:" in line:
                    try:
                        client_signal = int(line.split("signal:")[1].strip().split()[0])
                    except:
                        pass
                if "tx bitrate:" in line:
                    tx_rate = line.split("tx bitrate:")[1].strip().split()[0] + " Mbps"
                if "rx bitrate:" in line:
                    rx_rate = line.split("rx bitrate:")[1].strip().split()[0] + " Mbps"
        
        # Get public IP
        ip_public = ""
        try:
            pub_result = main.run_command(["curl", "-s", "--max-time", "3", "ifconfig.me"], check=False)
            if pub_result.returncode == 0:
                ip_public = pub_result.stdout.strip()
        except:
            pass
        
        # Detect ALL network interfaces and their status
        internet_source = ""
        internet_interface = ""
        internet_via = ""
        
        # Gather info on all secondary interfaces (not wlan0 hotspot)
        secondary_interfaces = []
        
        # Check wlan1 (TP-Link USB dongle)
        wlan1_ssid = ""
        wlan1_ip = ""
        wlan1_signal = 0
        try:
            wlan1_ip_result = main.run_command(["ip", "-4", "addr", "show", "wlan1"], check=False)
            if wlan1_ip_result.returncode == 0:
                for wline in wlan1_ip_result.stdout.split("\n"):
                    if "inet " in wline:
                        wlan1_ip = wline.strip().split()[1].split("/")[0]
                        break
            ssid_result = main.run_command(["iwgetid", "-r", "wlan1"], check=False)
            if ssid_result.returncode == 0 and ssid_result.stdout.strip():
                wlan1_ssid = ssid_result.stdout.strip()
            if wlan1_ssid or wlan1_ip:
                # Get signal strength
                iw_result = main.run_command(["iw", "dev", "wlan1", "link"], check=False)
                if iw_result.returncode == 0:
                    for wline in iw_result.stdout.split("\n"):
                        if "signal:" in wline:
                            try:
                                wlan1_signal = int(wline.split("signal:")[1].strip().split()[0])
                            except:
                                pass
                secondary_interfaces.append({
                    "name": "wlan1",
                    "type": "wifi",
                    "label": "WiFi USB (TP-Link)",
                    "ssid": wlan1_ssid,
                    "ip": wlan1_ip,
                    "signal": wlan1_signal,
                    "connected": bool(wlan1_ssid),
                })
        except:
            pass
        
        # Check USB interfaces (Huawei router, phone tethering)
        try:
            ip_link_result = main.run_command(["ip", "-j", "link", "show"], check=False)
            if ip_link_result.returncode == 0:
                all_links = json.loads(ip_link_result.stdout)
                for link in all_links:
                    iface_name = link.get("ifname", "")
                    if iface_name.startswith("usb") or iface_name.startswith("enx"):
                        usb_ip = ""
                        usb_ip_result = main.run_command(["ip", "-4", "addr", "show", iface_name], check=False)
                        if usb_ip_result.returncode == 0:
                            for wline in usb_ip_result.stdout.split("\n"):
                                if "inet " in wline:
                                    usb_ip = wline.strip().split()[1].split("/")[0]
                                    break
                        
                        # Identify USB device
                        usb_device_name = ""
                        try:
                            usb_result = main.run_command(["lsusb"], check=False)
                            if usb_result.returncode == 0:
                                for uline in usb_result.stdout.split("\n"):
                                    uline_lower = uline.lower()
                                    if any(kw in uline_lower for kw in ["huawei", "hilink", "rndis", "cdc ether", "android", "apple", "iphone", "samsung", "xiaomi"]):
                                        parts = uline.split(" ", 6)
                                        if len(parts) >= 7:
                                            usb_device_name = parts[6].strip()
                                        break
                        except:
                            pass
                        
                        operstate = link.get("operstate", "").upper()
                        secondary_interfaces.append({
                            "name": iface_name,
                            "type": "usb",
                            "label": usb_device_name or f"USB ({iface_name})",
                            "ssid": "",
                            "ip": usb_ip,
                            "signal": 0,
                            "connected": operstate == "UP" or bool(usb_ip),
                        })
        except:
            pass
        
        # Check eth0
        try:
            eth_result = main.run_command(["ip", "-4", "addr", "show", "eth0"], check=False)
            if eth_result.returncode == 0:
                eth_ip = ""
                for wline in eth_result.stdout.split("\n"):
                    if "inet " in wline:
                        eth_ip = wline.strip().split()[1].split("/")[0]
                        break
                if eth_ip:
                    secondary_interfaces.append({
                        "name": "eth0",
                        "type": "ethernet",
                        "label": "Ethernet",
                        "ssid": "",
                        "ip": eth_ip,
                        "signal": 0,
                        "connected": True,
                    })
        except:
            pass
        
        # Find which interface provides the default route (= internet)
        route_result = main.run_command(["ip", "route", "show", "default"], check=False)
        if route_result.returncode == 0:
            for line in route_result.stdout.strip().split("\n"):
                if "default" in line:
                    parts = line.split()
                    if "dev" in parts:
                        idx = parts.index("dev")
                        if idx + 1 < len(parts):
                            internet_interface = parts[idx + 1]
                    break
        
        # Label the internet source from the default route interface
        for si in secondary_interfaces:
            if si["name"] == internet_interface:
                si["isDefaultRoute"] = True
                internet_source = si["label"]
                if si["ssid"]:
                    internet_via = si["ssid"]
                break
        else:
            if internet_interface:
                internet_source = internet_interface
        
        # Test internet connectivity with ping
        has_internet = False
        ping_ms = 0
        try:
            ping_result = main.run_command(["ping", "-c", "1", "-W", "2", "8.8.8.8"], check=False)
            if ping_result.returncode == 0:
                has_internet = True
                # Parse ping time
                for pline in ping_result.stdout.split("\n"):
                    if "time=" in pline:
                        try:
                            ping_ms = float(pline.split("time=")[1].split()[0])
                        except:
                            pass
        except:
            pass
        
        # Quick download speed test (download a small file)
        download_speed = ""
        if has_internet:
            try:
                speed_result = main.run_command(
                    ["curl", "-s", "-w", "%{speed_download}", "-o", "/dev/null",
                     "--max-time", "5", "http://speedtest.tele2.net/1MB.zip"],
                    check=False
                )
                if speed_result.returncode == 0 and speed_result.stdout.strip():
                    speed_bps = float(speed_result.stdout.strip())
                    speed_mbps = (speed_bps * 8) / 1_000_000
                    if speed_mbps >= 1:
                        download_speed = f"{speed_mbps:.1f} Mbps"
                    else:
                        speed_kbps = (speed_bps * 8) / 1000
                        download_speed = f"{speed_kbps:.0f} kbps"
            except:
                pass
        
        return {
            "connected": bool(ip_local),
            "isHotspot": is_hotspot,
            "hotspotSsid": hotspot_ssid if is_hotspot else "",
            "ssid": client_ssid if not is_hotspot else "",
            "signal": client_signal,
            "txRate": tx_rate,
            "rxRate": rx_rate,
            "ipLocal": ip_local,
            "ipPublic": ip_public,
            "internetSource": internet_source,
            "internetInterface": internet_interface,
            "internetVia": internet_via,
            "hasInternet": has_internet,
            "pingMs": round(ping_ms, 1),
            "downloadSpeed": download_speed,
            "secondaryInterfaces": secondary_interfaces,
        }
    except Exception as e:
        return {"connected": False, "ssid": "", "signal": 0, "error": str(e)}


@router.get("/api/network/ethernet/status")
async def get_ethernet_status():
    """Get current Ethernet connection status"""
    try:
        connected = False
        ip_local = ""
        
        # Check eth0 status
        result = main.run_command(["ip", "-json", "addr", "show", "eth0"], check=False)
        if result.returncode == 0:
            data = json.loads(result.stdout)
            if data:
                for addr_info in data[0].get("addr_info", []):
                    if addr_info.get("family") == "inet":
                        ip_local = addr_info.get("local", "")
                        connected = True
                        break
        
        return {
            "connected": connected,
            "ipLocal": ip_local,
        }
    except Exception as e:
        return {"connected": False, "ipLocal": "", "error": str(e)}


@router.get("/api/network/hotspot/status")
async def hotspot_status_ep():
    """Etat du hotspot Wi-Fi (AP)"""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, hotspot.hotspot_status)


@router.get("/api/network/hotspot/credentials")
async def hotspot_credentials_ep():
    """SSID + mot de passe du hotspot (admin / system_network)"""
    loop = asyncio.get_event_loop()
    pw = await loop.run_in_executor(None, hotspot.get_or_create_hotspot_password)
    return {"ssid": hotspot.SSID_DEFAULT, "password": pw}


@router.post("/api/network/hotspot/credentials")
async def hotspot_set_credentials_ep(body: HotspotPassword):
    """Change le mot de passe du hotspot"""
    try:
        hotspot.set_hotspot_password(body.password)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True}


@router.post("/api/network/hotspot/start")
async def hotspot_start_ep():
    """Demarre le hotspot"""
    loop = asyncio.get_event_loop()
    pw = await loop.run_in_executor(None, hotspot.get_or_create_hotspot_password)
    return await loop.run_in_executor(None, hotspot.start_hotspot_blocking, hotspot.SSID_DEFAULT, pw)


@router.post("/api/network/hotspot/stop")
async def hotspot_stop_ep():
    """Arrete le hotspot"""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, hotspot.stop_hotspot)


@router.get("/api/network/wifi/saved")
async def get_saved_networks():
    """Get list of saved Wi-Fi networks"""
    try:
        result = main.run_command(["nmcli", "-t", "-f", "NAME,TYPE", "connection", "show"], check=False)
        saved = []
        if result.returncode == 0:
            for line in result.stdout.strip().split("\n"):
                parts = line.split(":")
                if len(parts) >= 2 and parts[1] == "802-11-wireless":
                    saved.append(parts[0])
        return {"saved": saved}
    except Exception as e:
        return {"saved": [], "error": str(e)}


@router.post("/api/network/wifi/connect")
async def connect_to_wifi(request: WifiConnectRequest):
    """Connect to a Wi-Fi network, handling hotspot->client transition safely"""
    try:
        # Step 1: Pause the network watchdog to prevent it from interfering
        main.run_command(["systemctl", "stop", "aurige-net-watchdog.timer"], check=False, timeout=5)
        
        # Step 2: Detect if currently in hotspot mode
        was_hotspot = False
        active_result = main.run_command(["nmcli", "-t", "-f", "NAME,TYPE,DEVICE", "connection", "show", "--active"], check=False)
        hotspot_conn_name = None
        if active_result.returncode == 0:
            for line in active_result.stdout.strip().split("\n"):
                parts = line.split(":")
                if len(parts) >= 3 and parts[2] == "wlan0":
                    conn_name = parts[0]
                    if "hotspot" in conn_name.lower() or "aurige" in conn_name.lower():
                        was_hotspot = True
                        hotspot_conn_name = conn_name
                    # Also check if in AP mode
                    mode_check = main.run_command(["nmcli", "-t", "-f", "GENERAL.MODE", "connection", "show", conn_name], check=False)
                    if mode_check.returncode == 0 and "ap" in mode_check.stdout.lower():
                        was_hotspot = True
                        hotspot_conn_name = conn_name
        
        # Step 3: If in hotspot mode, disable it first to free wlan0
        if was_hotspot and hotspot_conn_name:
            main.run_command(["nmcli", "connection", "down", hotspot_conn_name], check=False, timeout=10)
            time.sleep(2)
            main.run_command(["nmcli", "device", "wifi", "rescan"], check=False, timeout=10)
            time.sleep(3)
        
        # Step 4: If password provided for a new network, always create/update the profile first
        # This ensures the password is saved even if the first connect attempt times out
        if request.password:
            # Delete old profile if it exists (to update password)
            main.run_command(["nmcli", "connection", "delete", request.ssid], check=False, timeout=5)
            time.sleep(1)
            
            # Create a new saved connection profile with the password
            add_result = main.run_command([
                "nmcli", "connection", "add",
                "type", "wifi",
                "con-name", request.ssid,
                "ssid", request.ssid,
                "wifi-sec.key-mgmt", "wpa-psk",
                "wifi-sec.psk", request.password,
                "connection.autoconnect", "yes",
                "connection.autoconnect-priority", "100"
            ], check=False, timeout=15)
            
            if add_result.returncode != 0:
                main.logger.warning(f"Failed to save WiFi profile: {add_result.stderr}")
        
        # Step 5: Check if this network is already saved (it should be after step 4)
        saved_result = main.run_command(["nmcli", "-t", "-f", "NAME,TYPE", "connection", "show"], check=False)
        is_saved = False
        if saved_result.returncode == 0:
            for line in saved_result.stdout.strip().split("\n"):
                parts = line.split(":")
                if len(parts) >= 2 and parts[0] == request.ssid and parts[1] == "802-11-wireless":
                    is_saved = True
                    break
        
        # Step 6: Connect - always use "connection up" since we saved the profile
        if is_saved:
            result = main.run_command([
                "nmcli", "connection", "up", request.ssid
            ], check=False, timeout=30)
        else:
            # Fallback: direct connect (open networks without password)
            result = main.run_command([
                "nmcli", "device", "wifi", "connect", request.ssid
            ], check=False, timeout=30)
        
        if result.returncode == 0:
            # Ensure autoconnect with high priority
            main.run_command([
                "nmcli", "connection", "modify", request.ssid,
                "connection.autoconnect", "yes",
                "connection.autoconnect-priority", "100"
            ], check=False)
            
            # Lower USB modem priority so WiFi stays preferred
            usb_conns = main.run_command(["nmcli", "-t", "-f", "NAME,TYPE,DEVICE", "connection", "show"], check=False)
            if usb_conns.returncode == 0:
                for line in usb_conns.stdout.strip().split("\n"):
                    parts = line.split(":")
                    if len(parts) >= 3:
                        dev = parts[2] if len(parts) > 2 else ""
                        # USB modem interfaces (cdc-wdm, usb0, wwan0, etc.)
                        if any(x in dev for x in ["usb", "cdc", "wwan", "enx"]):
                            main.run_command([
                                "nmcli", "connection", "modify", parts[0],
                                "connection.autoconnect-priority", "10"
                            ], check=False)
            
            # Restart watchdog now that WiFi is connected
            main.run_command(["systemctl", "start", "aurige-net-watchdog.timer"], check=False, timeout=5)
            
            return {"status": "success", "message": f"Connecte a {request.ssid}"}
        else:
            error_msg = result.stderr.strip() if result.stderr else result.stdout.strip() if result.stdout else "Connexion echouee"
            
            # FALLBACK: If connection failed and we disabled hotspot, re-enable it
            if was_hotspot and hotspot_conn_name:
                main.run_command(["nmcli", "connection", "up", hotspot_conn_name], check=False, timeout=15)
                error_msg += " (Hotspot reactive)"
            
            # Restart watchdog
            main.run_command(["systemctl", "start", "aurige-net-watchdog.timer"], check=False, timeout=5)
            
            return {"status": "error", "message": error_msg}
    except Exception as e:
        # FALLBACK: Re-enable hotspot on any exception
        if was_hotspot and hotspot_conn_name:
            try:
                main.run_command(["nmcli", "connection", "up", hotspot_conn_name], check=False, timeout=15)
            except Exception:
                pass
        # Always restart watchdog
        main.run_command(["systemctl", "start", "aurige-net-watchdog.timer"], check=False, timeout=5)
        return {"status": "error", "message": str(e)}
