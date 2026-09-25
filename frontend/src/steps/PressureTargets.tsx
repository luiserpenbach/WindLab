import { useAnalysis } from '../state/analysis';
import { findMat, isPolymerLiner, useMaterialLists } from '../state/materials';
import { useProject } from '../state/projectStore';
import { sig } from '../util/format';
import { NO_AUTOFRETTAGE_NOTE } from './shared';

/** Expected water-jacket readings (StructuralResult.expansion_*): Analysis, Testing and Export steps. */
export function PressureTargets({ compact }: { compact?: boolean }) {
  const { result, resultProject } = useAnalysis();
  const { project } = useProject();
  const lists = useMaterialLists();
  const st = result?.structural;
  if (!st) return null;
  const proof = st.at_proof.pressure;
  const shown = resultProject ?? project;
  const tRef = shown.requirements.temperature_ref;
  // Type IV: no autofrettage, the first load is the proof test.
  const polymer = isPolymerLiner(findMat(lists.liners, shown.liner.material)?.rec);
  const rows: { k: string; p: number; tot: number; perm: number; permLabel: string }[] = [
    ...(polymer
      ? []
      : [
          {
            k: 'Autofrettage',
            p: st.autofrettage_pressure,
            tot: st.expansion_af_total,
            perm: st.expansion_af_permanent,
            permLabel: 'permanent after venting',
          },
        ]),
    {
      k: 'Proof',
      p: proof,
      tot: st.expansion_proof_total,
      perm: st.expansion_proof_permanent,
      permLabel: polymer ? 'permanent after venting' : 'additional permanent',
    },
  ];
  const z = (v: number) => (Math.abs(v) < 1e-6 ? 0 : v);
  const pct = (v: number, t: number) => (t > 0 && z(v) > 0 ? ` (${sig((v / t) * 100, 2)} %)` : '');
  return (
    <div className={`card pt-card ${compact ? 'subtle' : ''}`}>
      <div className="card-title">Pressure test targets · water jacket</div>
      <table className="data-table compact pt-table">
        <thead>
          <tr>
            <th>Test</th>
            <th className="num">p MPa</th>
            <th className="num" title="Total volumetric expansion at the test pressure [mL]">
              ΔV total mL
            </th>
            <th className="num" title="Permanent volumetric expansion [mL]">
              ΔV perm. mL
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((x) => (
            <tr key={x.k}>
              <td>{x.k}</td>
              <td className="num" title={`${sig(x.p * 10, 4)} bar`}>
                {sig(x.p, 4)}
              </td>
              <td className="num">{sig(z(x.tot), 4)}</td>
              <td className="num" title={`${x.permLabel}${pct(x.perm, x.tot)}`}>
                {sig(z(x.perm), 3)}
                <span className="muted">{pct(x.perm, x.tot)}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="muted small">
        Expected water-jacket readings at {sig(tRef, 3)} °C.{' '}
        {polymer
          ? NO_AUTOFRETTAGE_NOTE
          : 'Proof permanent expansion is in addition to the autofrettage set; a much larger value points to a liner or bond problem.'}
      </div>
    </div>
  );
}
