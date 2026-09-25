import type { ComponentType } from 'react';
import type { StepId } from '../state/uiStore';
import { AnalysisBottom, AnalysisPanel } from './AnalysisStep';
import { ExportBottom, ExportPanel } from './ExportStep';
import { LayupBottom, LayupPanel } from './LayupStep';
import { MachinePanel } from './MachineStep';
import { MaterialsBottom, MaterialsPanel } from './MaterialsStep';
import { SimulateBottom, SimulatePanel } from './SimulateStep';
import { TestingBottom, TestingPanel } from './TestingStep';
import { ThicknessBottom, ThicknessPanel } from './ThicknessStep';
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
  materials: { Panel: MaterialsPanel, Bottom: MaterialsBottom, bottomTall: true },
  layup: { Panel: LayupPanel, Bottom: LayupBottom },
  thickness: { Panel: ThicknessPanel, Bottom: ThicknessBottom },
  analysis: { Panel: AnalysisPanel, Bottom: AnalysisBottom },
  testing: { Panel: TestingPanel, Bottom: TestingBottom, bottomTall: true },
  machine: { Panel: MachinePanel },
  simulate: { Panel: SimulatePanel, Bottom: SimulateBottom },
  export: { Panel: ExportPanel, Bottom: ExportBottom, bottomTall: true },
};
