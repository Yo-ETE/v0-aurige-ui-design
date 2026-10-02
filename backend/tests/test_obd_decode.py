import main


def test_dtc_pcode():
    # 7E8 single frame: 04 43 01 03 00 00 ...  -> one DTC P0103
    r = main.decode_dtcs_from_frames(["(0.0) can0 7E8#0443010300000000"])
    assert r == [{"code": "P0103", "description": main.dtc_description("P0103"), "category": "P"}]


def test_dtc_ccode_bcode_ucode_categories():
    # b1=0x43 -> category C, first digit 0, rest 300 -> C0300 ; b1=0x83 -> B ; b1=0xC3 -> U
    assert main.decode_dtcs_from_frames(["(0) can0 7E8#0443430000000000"])[0]["code"] == "C0300"
    assert main.decode_dtcs_from_frames(["(0) can0 7E8#0443830000000000"])[0]["code"] == "B0300"
    assert main.decode_dtcs_from_frames(["(0) can0 7E8#04434300000000"])[0]["category"] == "C"
    assert main.decode_dtcs_from_frames(["(0) can0 7E8#0443C30000000000"])[0]["code"] == "U0300"


def test_dtc_zero_is_no_code():
    assert main.decode_dtcs_from_frames(["(0) can0 7E8#0243000000000000"]) == []


def test_dtc_service_param_pending_permanent():
    # response service 0x47 (Mode 07) still decodes the DTC bytes
    r = main.decode_dtcs_from_frames(["(0) can0 7E8#0447010300000000"], response_service=0x47)
    assert r[0]["code"] == "P0103"


def test_dtc_description_known_and_fallback():
    assert main.dtc_description("P0100")  # known generic
    fb = main.dtc_description("P2FFF")
    assert isinstance(fb, str) and fb  # non-empty fallback, no crash


def test_dtc_single_frame_ignores_nonzero_padding():
    r = main.decode_dtcs_from_frames(["(0) can0 7E8#0443010355555555"])
    assert [d["code"] for d in r] == ["P0103"]


def test_dtc_low_byte_formatting():
    r = main.decode_dtcs_from_frames(["(0) can0 7E8#044301AB00000000"])
    assert r[0]["code"] == "P01AB"


def test_dtc_multiframe_first_frame():
    # 10 05 43 | 0103 0204 | pad
    r = main.decode_dtcs_from_frames(["(0) can0 7E8#1005430103020400"])
    assert [d["code"] for d in r] == ["P0103", "P0204"]
