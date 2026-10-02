import dbc_store as ds
import validators


def _sig(can_id="0C6", name="Spd", start_bit=0, length=8, **kw):
    base = dict(id="", can_id=can_id, name=name, start_bit=start_bit, length=length,
                byte_order="little_endian", is_signed=False, scale=1, offset=0,
                min_val=0, max_val=255, unit="", comment="")
    base.update(kw)
    return base


def test_upsert_signal_autocreates_message():
    doc = ds.new_doc()
    sid = ds.upsert_signal(doc, _sig())
    assert sid
    assert len(doc["messages"]) == 1
    msg = doc["messages"][0]
    assert msg["can_id"] == "0C6"
    assert msg["name"] == "MSG_0C6"
    assert msg["dlc"] == 8
    assert len(msg["signals"]) == 1


def test_upsert_message_metadata_only_keeps_signals():
    doc = ds.new_doc()
    ds.upsert_signal(doc, _sig())
    ds.upsert_message(doc, "0C6", name="BrakeStatus", dlc=6, comment="frein")
    msg = doc["messages"][0]
    assert msg["name"] == "BrakeStatus"
    assert msg["dlc"] == 6
    assert msg["comment"] == "frein"
    assert len(msg["signals"]) == 1  # signals untouched


def test_upsert_message_creates_empty_message():
    doc = ds.new_doc()
    ds.upsert_message(doc, "123", name="Empty", dlc=8)
    assert doc["messages"][0]["can_id"] == "123"
    assert doc["messages"][0]["signals"] == []


def test_delete_signal_and_message():
    doc = ds.new_doc()
    sid = ds.upsert_signal(doc, _sig())
    assert ds.delete_signal(doc, sid) == 1
    assert doc["messages"][0]["signals"] == []
    assert ds.delete_message(doc, "0C6") == 1
    assert doc["messages"] == []


def test_dbc_ident_sanitizes():
    assert ds.dbc_ident("Brake Status", "X") == "Brake_Status"
    assert ds.dbc_ident("3phase", "X") == "_3phase"
    assert ds.dbc_ident("", "FALLBACK") == "FALLBACK"
    assert ds.dbc_ident("a-b.c", "X") == "a_b_c"


def test_export_standard_id():
    doc = ds.new_doc()
    ds.upsert_signal(doc, _sig(can_id="1B0", name="Rpm", length=16, byte_order="big_endian"))
    txt = ds.dbc_to_text(doc)
    assert "BO_ 432 MSG_1B0: 8 Vector__XXX" in txt  # 0x1B0 == 432, standard id
    assert " SG_ Rpm : 0|16@0+ (1,0) [0|255] \"\" Vector__XXX" in txt
    assert "NS_ :" in txt and "CM_" in txt  # NS_ block lists standard symbols


def test_export_extended_id_sets_bit31():
    doc = ds.new_doc()
    ds.upsert_signal(doc, _sig(can_id="18DAF110", name="Diag"))
    txt = ds.dbc_to_text(doc)
    bo_id = int("18DAF110", 16) | 0x80000000
    assert f"BO_ {bo_id} MSG_18DAF110: 8 Vector__XXX" in txt


def test_export_sanitizes_names():
    doc = ds.new_doc()
    ds.upsert_message(doc, "090", name="3Wheel Speed")
    ds.upsert_signal(doc, _sig(can_id="090", name="FL Speed"))
    txt = ds.dbc_to_text(doc)
    assert "BO_ 144 _3Wheel_Speed: 8 Vector__XXX" in txt
    assert " SG_ FL_Speed :" in txt


def test_valid_dbc_id():
    for ok in ["clio", "my-dbc-1", "a", "0"]:
        assert validators.valid_dbc_id(ok), ok
    for bad in ["", "A", "../x", "a/b", "a.b", "x" * 65, "a_b", None, 123]:
        assert not validators.valid_dbc_id(bad), bad


def test_export_signed_flag():
    doc = ds.new_doc()
    ds.upsert_signal(doc, _sig(name="A", is_signed=True))
    ds.upsert_signal(doc, _sig(name="B", is_signed=True, byte_order="big_endian", start_bit=8))
    txt = ds.dbc_to_text(doc)
    assert " SG_ A : 0|8@1- " in txt
    assert " SG_ B : 8|8@0- " in txt


def test_export_scale_offset_range_unit():
    doc = ds.new_doc()
    ds.upsert_signal(doc, _sig(scale=0.25, offset=-40, min_val=-40, max_val=215, unit="degC"))
    txt = ds.dbc_to_text(doc)
    assert '(0.25,-40) [-40|215] "degC" Vector__XXX' in txt


def test_export_comments():
    doc = ds.new_doc()
    ds.upsert_message(doc, "0C6", comment="frein")
    ds.upsert_signal(doc, _sig(name="Spd", comment="vitesse"))
    txt = ds.dbc_to_text(doc)
    assert 'CM_ BO_ 198 "frein";' in txt
    assert 'CM_ SG_ 198 Spd "vitesse";' in txt


def test_export_escapes_quotes_and_newlines():
    doc = ds.new_doc()
    ds.upsert_message(doc, "0C6", comment='dit "stop"\nligne2')
    ds.upsert_signal(doc, _sig(name="Spd", unit='k"m', comment='a"b'))
    txt = ds.dbc_to_text(doc)
    assert 'CM_ BO_ 198 "dit \\"stop\\" ligne2";' in txt
    assert '"k\\"m" Vector__XXX' in txt
    assert 'CM_ SG_ 198 Spd "a\\"b";' in txt


def test_upsert_signal_same_id_updates_in_place():
    doc = ds.new_doc()
    sid = ds.upsert_signal(doc, _sig(id="fixed", length=8))
    sid2 = ds.upsert_signal(doc, _sig(id="fixed", length=12, scale=2))
    assert sid == sid2 == "fixed"
    sigs = doc["messages"][0]["signals"]
    assert len(sigs) == 1
    assert sigs[0]["length"] == 12 and sigs[0]["scale"] == 2


def test_can_id_case_normalized():
    doc = ds.new_doc()
    ds.upsert_signal(doc, _sig(can_id="0c6", name="A"))
    ds.upsert_signal(doc, _sig(can_id="0C6", name="B"))
    assert len(doc["messages"]) == 1
    assert doc["messages"][0]["can_id"] == "0C6"
    assert len(doc["messages"][0]["signals"]) == 2


def test_extended_id_boundary():
    doc = ds.new_doc()
    ds.upsert_message(doc, "7FF")
    ds.upsert_message(doc, "800")
    txt = ds.dbc_to_text(doc)
    assert "BO_ 2047 MSG_7FF:" in txt
    assert f"BO_ {0x800 | 0x80000000} MSG_800:" in txt
