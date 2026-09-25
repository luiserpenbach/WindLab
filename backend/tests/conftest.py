import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from windlab import schemas as S  # noqa: E402


@pytest.fixture(scope="session")
def sized_project() -> S.Project:
    from windlab.core.design import suggest_layup

    p = S.Project()
    p.layers, _ = suggest_layup(p)
    return p
