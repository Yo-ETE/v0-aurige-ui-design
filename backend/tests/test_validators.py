import validators


def test_valid_git_ref_accepts():
    for r in ["main", "audit-remediation", "feature/x_1.2", "v0/yo-ete-5c91d9cb", "release/1.0.0"]:
        assert validators.valid_git_ref(r), r


def test_valid_git_ref_rejects():
    for r in ["", "-rm", "-rf", "a..b", "a b", "a;b", "a$b", "a//b", "/lead", "x" * 201, "main\n", "main\t"]:
        assert not validators.valid_git_ref(r), r
    assert not validators.valid_git_ref(None)  # type: ignore
    assert not validators.valid_git_ref(123)  # type: ignore
