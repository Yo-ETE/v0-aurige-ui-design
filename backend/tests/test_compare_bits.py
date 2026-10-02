def _changed_bits(a: int, b: int):
    return [bit for bit in range(8) if (a ^ b) >> bit & 1]

def test_changed_bits_single():
    assert _changed_bits(0x00, 0x04) == [2]

def test_changed_bits_multi():
    assert _changed_bits(0x00, 0x05) == [0, 2]

def test_changed_bits_none():
    assert _changed_bits(0x0F, 0x0F) == []
