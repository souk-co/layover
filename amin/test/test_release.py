"""Release metadata extraction must survive bundle formatting before publication."""
import sys
from pathlib import Path
import pytest

sys.path.insert(0, str(Path(__file__).parents[1]))
from build import bundle
from release import program_resip


def test_release_reads_resip_from_compacted_bundle_and_override():
    assert program_resip(bundle()["souk.py"]) == "https://pod.dstack.soc1024.com/resip-staging"
    assert program_resip(bundle("https://example.test/resip")["souk.py"]) == "https://example.test/resip"
    assert program_resip("RESIP='https://example.test'\n") == "https://example.test"


@pytest.mark.parametrize("source", ["OTHER='url'", "RESIP=call()", "RESIP='one'\nRESIP='two'"])
def test_release_refuses_missing_dynamic_or_ambiguous_resip(source):
    with pytest.raises(ValueError):
        program_resip(source)


def test_release_workers_are_bounded_by_default_and_explicit_override(monkeypatch):
    from release import test_workers as workers
    monkeypatch.delenv("AMIN_TEST_WORKERS", raising=False)
    assert workers() == "4"
    monkeypatch.setenv("AMIN_TEST_WORKERS", "2")
    assert workers() == "2"
    for invalid in ("0", "auto"):
        monkeypatch.setenv("AMIN_TEST_WORKERS", invalid)
        with pytest.raises(ValueError):
            workers()
