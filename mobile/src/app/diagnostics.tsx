import { DiagnosticsPanel } from '@/features/diagnostics/DiagnosticsPanel';
import { Screen } from '@/ui/components';

export default function DiagnosticsScreen() {
  return (
    <Screen edges={['bottom']}>
      <DiagnosticsPanel />
    </Screen>
  );
}
