"""AURIGE - Validateurs d'entrées (sûreté shell / git)."""
import re

_GIT_REF = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]*$")


def valid_git_ref(ref) -> bool:
    if not isinstance(ref, str):
        return False
    if not (1 <= len(ref) <= 200):
        return False
    if ".." in ref or "//" in ref:
        return False
    return bool(_GIT_REF.match(ref))
