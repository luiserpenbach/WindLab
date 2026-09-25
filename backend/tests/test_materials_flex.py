import pytest

from windlab import schemas as S
from windlab.core.design import analyze, build
from windlab.core.materials import band_thickness, get_fiber


def test_glass_outer_layer_changes_thickness_mass_and_stiffness(sized_project):
    glass = S.Layer(id="glass", type="hoop", fiber="E-glass-2400", passes=2)
    carbon = S.Layer(id="carb", type="hoop", passes=2)
    rg = analyze(sized_project.model_copy(update={"layers": sized_project.layers + [glass]}))
    rc = analyze(sized_project.model_copy(update={"layers": sized_project.layers + [carbon]}))
    g, c = rg.layers[-1], rc.layers[-1]
    Vf = sized_project.composite.fiber_volume_fraction
    assert g.band_thickness == pytest.approx(band_thickness(get_fiber("E-glass-2400"), 1, 6.0, Vf))
    assert g.fiber_mass > c.fiber_mass
    # glass barely adds burst strength compared with carbon
    assert rg.structural.burst_pressure < rc.structural.burst_pressure


def test_custom_materials_take_precedence():
    lib = S.MaterialLibrary(
        fibers=[S.CustomFiber(id="MYCF", name="Lot 42 carbon", E=240_000, strength=5200, density=1.8, tex=800)],
        liners=[S.CustomLiner(id="AL-LOT7", name="6061-T6 lot 7", E=69_000, yield_=290, ultimate=320, density=2.7,
                              fatigue_coeff=400, fatigue_exp=-0.07)],
    )
    p = S.Project(materials=lib, composite=S.CompositeSpec(fiber="MYCF"), liner=S.LinerSpec(material="AL-LOT7"),
                  layers=[S.Layer(id="c", type="hoop"), S.Layer(id="h", type="helical"), S.Layer(id="c2", type="hoop")])
    b = build(p)
    assert b.fiber.name == "Lot 42 carbon"
    res = analyze(p)
    assert res.structural.fiber_strength == pytest.approx(0.82 * 5200)
    # round-trips through JSON with the "yield" alias
    again = S.Project.model_validate_json(p.model_dump_json(by_alias=True))
    assert again.materials.liners[0].yield_ == 290


def test_hoop_overlap_thickens_layer():
    base = S.Project(layers=[S.Layer(id="c", type="hoop")])
    over = S.Project(layers=[S.Layer(id="c", type="hoop", overlap=0.5)])
    t0 = build(base).layers[0].t_cyl
    t1 = build(over).layers[0].t_cyl
    assert t1 == pytest.approx(2 * t0)
