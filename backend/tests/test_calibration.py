import pytest

from windlab import schemas as S
from windlab.core.calibration import calibrate
from windlab.core.design import analyze


def test_expansion_is_consistent(sized_project):
    st = analyze(sized_project).structural
    assert st.expansion_af_total > st.expansion_af_permanent > 0
    assert abs(st.expansion_proof_permanent) < 0.05 * st.expansion_proof_total  # proof below AF: elastic


def test_calibration_scales_efficiency(sized_project):
    pred = analyze(sized_project).structural.burst_pressure
    tests = [S.TestRecord(id=f"t{i}", pressure=pred * f) for i, f in enumerate((0.9, 0.92, 0.94))]
    r = calibrate(sized_project.model_copy(update={"tests": tests}))
    eta = sized_project.composite.translation_efficiency
    assert r.burst_mean_ratio == pytest.approx(0.92, rel=1e-6)
    assert r.suggested_efficiency == pytest.approx(0.92 * eta, rel=1e-6)
    assert r.b_basis_efficiency < r.suggested_efficiency
    # re-running with the suggested efficiency brings predictions onto the tests (liner share makes it approximate)
    p2 = sized_project.model_copy(update={"composite": sized_project.composite.model_copy(
        update={"translation_efficiency": r.suggested_efficiency})})
    assert analyze(p2).structural.burst_pressure == pytest.approx(0.92 * pred, rel=0.03)
