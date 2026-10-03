"""AURIGE - Domaine Tailscale (VPN). Extrait de main.py, routes inchangees."""
import json

from fastapi import APIRouter, Query

import main

router = APIRouter()


@router.get("/api/tailscale/status")
async def tailscale_status():
    """Get Tailscale VPN status including peers, IP, and connection info"""
    # Check if tailscale is installed
    which_result = main.run_command(["which", "tailscale"], check=False)
    if which_result.returncode != 0:
        return {
            "installed": False,
            "running": False,
            "hostname": "",
            "tailscaleIp": "",
            "magicDns": "",
            "online": False,
            "exitNode": False,
            "os": "",
            "version": "",
            "peers": [],
            "authUrl": "",
        }
    
    # Get version
    version = ""
    ver_result = main.run_command(["tailscale", "version"], check=False)
    if ver_result.returncode == 0:
        version = ver_result.stdout.strip().split("\n")[0]
    
    # Get status as JSON
    result = main.run_command(["tailscale", "status", "--json"], check=False)
    if result.returncode != 0:
        return {
            "installed": True,
            "running": False,
            "hostname": "",
            "tailscaleIp": "",
            "magicDns": "",
            "online": False,
            "exitNode": False,
            "os": "",
            "version": version,
            "peers": [],
            "authUrl": "",
        }
    
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError:
        return {
            "installed": True,
            "running": False,
            "hostname": "",
            "tailscaleIp": "",
            "magicDns": "",
            "online": False,
            "exitNode": False,
            "os": "",
            "version": version,
            "peers": [],
            "authUrl": "",
        }
    
    # Parse self info
    self_info = data.get("Self", {})
    ts_ips = self_info.get("TailscaleIPs", [])
    tailscale_ip = ts_ips[0] if ts_ips else ""
    dns_name = self_info.get("DNSName", "").rstrip(".")
    is_online = self_info.get("Online", False)
    hostname = self_info.get("HostName", "")
    ts_os = self_info.get("OS", "")
    backend_state = data.get("BackendState", "")
    
    # Check if using an exit node
    exit_node_active = False
    prefs = data.get("Prefs", {})
    if prefs:
        exit_node_id = prefs.get("ExitNodeID", "")
        exit_node_active = bool(exit_node_id)
    
    # Auth URL (if needs re-auth)
    auth_url = data.get("AuthURL", "")
    
    # Parse peers
    peers = []
    peer_map = data.get("Peer", {})
    for peer_id, peer in peer_map.items():
        peer_ips = peer.get("TailscaleIPs", [])
        peer_dns = peer.get("DNSName", "").rstrip(".")
        peer_online = peer.get("Online", False)
        peer_hostname = peer.get("HostName", "")
        peer_os = peer.get("OS", "")
        peer_exit = peer.get("ExitNode", False)
        peer_exit_offer = peer.get("ExitNodeOption", False)
        
        # Calculate last seen
        last_seen = peer.get("LastSeen", "")
        
        # Rx/Tx bytes
        rx_bytes = peer.get("RxBytes", 0)
        tx_bytes = peer.get("TxBytes", 0)
        
        peers.append({
            "id": peer_id,
            "hostname": peer_hostname,
            "dnsName": peer_dns,
            "os": peer_os,
            "online": peer_online,
            "ip": peer_ips[0] if peer_ips else "",
            "isExitNode": peer_exit,
            "exitNodeOption": peer_exit_offer,
            "lastSeen": last_seen,
            "rxBytes": rx_bytes,
            "txBytes": tx_bytes,
        })
    
    # Sort: online first, then by hostname
    peers.sort(key=lambda p: (not p["online"], p["hostname"].lower()))
    
    return {
        "installed": True,
        "running": backend_state == "Running",
        "backendState": backend_state,
        "hostname": hostname,
        "tailscaleIp": tailscale_ip,
        "magicDns": dns_name,
        "online": is_online,
        "exitNode": exit_node_active,
        "os": ts_os,
        "version": version,
        "peers": peers,
        "authUrl": auth_url,
    }


@router.post("/api/tailscale/up")
async def tailscale_up():
    """Start Tailscale / connect to the network"""
    result = main.run_command(["sudo", "tailscale", "up", "--accept-routes"], check=False, timeout=15)
    if result.returncode == 0:
        return {"status": "success", "message": "Tailscale connecte"}
    
    # Check if needs auth
    if "https://" in (result.stderr or result.stdout or ""):
        # Extract auth URL
        output = result.stderr or result.stdout or ""
        url = ""
        for word in output.split():
            if word.startswith("https://"):
                url = word
                break
        return {"status": "auth_needed", "message": "Authentification requise", "authUrl": url}
    
    return {"status": "error", "message": result.stderr or result.stdout or "Erreur inconnue"}


@router.post("/api/tailscale/down")
async def tailscale_down():
    """Disconnect Tailscale"""
    result = main.run_command(["sudo", "tailscale", "down"], check=False, timeout=10)
    if result.returncode == 0:
        return {"status": "success", "message": "Tailscale deconnecte"}
    return {"status": "error", "message": result.stderr or "Erreur"}


@router.post("/api/tailscale/logout")
async def tailscale_logout():
    """Logout from Tailscale (will need re-auth)"""
    result = main.run_command(["sudo", "tailscale", "logout"], check=False, timeout=10)
    if result.returncode == 0:
        return {"status": "success", "message": "Deconnexion du compte Tailscale"}
    return {"status": "error", "message": result.stderr or "Erreur"}


@router.post("/api/tailscale/set-exit-node")
async def tailscale_set_exit_node(peer_ip: str = Query(default="")):
    """Set or clear exit node"""
    if peer_ip:
        result = main.run_command(
            ["sudo", "tailscale", "set", "--exit-node", peer_ip],
            check=False, timeout=10
        )
    else:
        result = main.run_command(
            ["sudo", "tailscale", "set", "--exit-node="],
            check=False, timeout=10
        )
    
    if result.returncode == 0:
        msg = f"Exit node: {peer_ip}" if peer_ip else "Exit node desactive"
        return {"status": "success", "message": msg}
    return {"status": "error", "message": result.stderr or "Erreur"}
