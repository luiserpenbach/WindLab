import type { ComponentType } from 'react';
import type { StepId } from '../state/uiStore';
import { AnalysisBottom, AnalysisPanel } from './AnalysisStep';
import { ExportBottom, ExportPanel } from './ExportStep';
import { LayupBottom, LayupPanel } from './LayupStep';
import { MachinePanel } from './MachineStep';
import { MaterialsPanel } from './MaterialsStep';
import { SimulateBottom, SimulatePanel } from './SimulateStep';
import { VesselBottom, VesselPanel } from './VesselStep';

export interface StepView {
  Panel: ComponentType;
  /** Optional chart / output area below the 3D viewport. */
  Bottom?: ComponentType;
  /** Give the bottom area more height than the viewport. */
  bottomTall?: boolean;
}

export const STEP_VIEWS: Record<StepId, StepView> = {
  vessel: { Panel: VesselPanel, Bottom: VesselBottom },
  materials: { Panel: MaterialsPanel },
  layup: { Panel: LayupPanel, Bottom: LayupBottom },
  analysis: { Panel: AnalysisPanel, Bottom: AnalysisBottom },
  machine: { Panel: MachinePanel },
  simulate: { Panel: SimulatePanel, Bottom: SimulateBottom },
  export: { Panel: ExportPanel, Bottom: ExportBottom, bottomTall: true },
};
