"""Client UDS (ISO 14229) minimal sur ISO-TP — framing requête single-frame + décodage réponse/NRC.

Outil de diagnostic/reverse sur le propre véhicule de l'utilisateur (test d'actionneurs, lecture DID,
security access…). L'injection réelle passe par le router (`routers/uds.py`, garde `can_inject` +
confirmation UI). Ici : helpers purs, aucune I/O bus, aucune clé persistée.
"""

import re

# Codes de réponse négative UDS courants → libellé FR.
NRC = {
    0x10: "rejet general",
    0x11: "service non supporte",
    0x12: "sous-fonction non supportee",
    0x13: "longueur/format de requete invalide",
    0x14: "reponse trop longue",
    0x21: "occupe, repeter",
    0x22: "conditions incorrectes",
    0x24: "sequence de requete invalide",
    0x31: "hors plage (requestOutOfRange)",
    0x33: "acces securite refuse",
    0x35: "cle invalide",
    0x36: "nombre de tentatives depasse",
    0x37: "delai requis non ecoule",
    0x70: "echec de programmation",
    0x78: "reponse en attente (responsePending)",
    0x7E: "sous-fonction non supportee dans cette session",
    0x7F: "service non supporte dans cette session",
}

_HEX_RE = re.compile(r"^[0-9A-Fa-f]*$")


def _clean(h: str) -> str:
    """Normalise une chaîne hex : retire espaces, met en majuscules."""
    return (h or "").replace(" ", "").replace("\t", "").upper()


def build_single_frame(service_hex: str, data_hex: str) -> str:
    """Construit une trame ISO-TP single-frame : `{len:02X}{service}{data}` padée à 8 octets.

    `len` = nombre d'octets de (service + data). Lève ValueError si >7 octets (multi-frame non
    supporté) ou si l'entrée n'est pas une suite d'octets hex valides.
    """
    service = _clean(service_hex)
    data = _clean(data_hex)
    if not _HEX_RE.match(service) or not _HEX_RE.match(data):
        raise ValueError("Hex invalide")
    payload = service + data
    if len(payload) % 2 != 0:
        raise ValueError("Longueur hex impaire (octets incomplets)")
    n = len(payload) // 2
    if n < 1:
        raise ValueError("Requete vide")
    if n > 7:
        raise ValueError("Requete multi-frame non supportee (>7 octets)")
    frame = f"{n:02X}{payload}"
    return frame.ljust(16, "0")  # pad à 8 octets


def reassemble_isotp(frames: list) -> bytes:
    """Réassemble la charge utile UDS depuis des trames ISO-TP (data hex de 8 octets, dans l'ordre).

    - Single frame : `0n <payload n octets>`.
    - Multi-frame : first frame `1L LL <6 octets>` (longueur sur 12 bits) puis consécutifs `2x <7 octets>`.
    Retourne les octets de charge utile (service + data), sans le PCI.
    """
    if not frames:
        return b""
    first = bytes.fromhex(_clean(frames[0]))
    if not first:
        return b""
    pci_type = first[0] >> 4
    if pci_type == 0:  # single frame
        length = first[0] & 0x0F
        return first[1:1 + length]
    if pci_type == 1:  # first frame d'un multi-frame
        length = ((first[0] & 0x0F) << 8) | first[1]
        payload = bytearray(first[2:])
        for f in frames[1:]:
            fb = bytes.fromhex(_clean(f))
            if not fb or (fb[0] >> 4) != 2:  # consecutive frame 2x
                continue
            payload.extend(fb[1:])
        return bytes(payload[:length])
    # Trame inattendue : renvoyer brut sans le 1er octet
    return first[1:]


def decode_response(frames: list) -> dict:
    """Décode la réponse UDS réassemblée depuis les trames (data hex) déjà filtrées sur le response_id.

    Retour : {raw, positive, service_echo?, data_hex?, nrc?:{code,label}, error?}.
    """
    payload = reassemble_isotp(frames)
    raw = payload.hex().upper()
    if not payload:
        return {"raw": "", "positive": False, "data_hex": "", "error": "pas de reponse"}
    if payload[0] == 0x7F:
        # Réponse négative : 7F <service> <nrc>
        service_echo = payload[1] if len(payload) > 1 else None
        nrc_code = payload[2] if len(payload) > 2 else None
        return {
            "raw": raw,
            "positive": False,
            "service_echo": service_echo,
            "nrc": {"code": nrc_code, "label": NRC.get(nrc_code, "inconnu")} if nrc_code is not None else None,
        }
    # Réponse positive : service + 0x40, suivi des données.
    return {
        "raw": raw,
        "positive": True,
        "service_echo": payload[0],
        "data_hex": payload[1:].hex().upper(),
    }
