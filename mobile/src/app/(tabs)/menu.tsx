import { useRouter } from 'expo-router';

import { useIsLive } from '@/realtime/hooks';
import { Button, Screen, T } from '@/ui/components';

export default function MenuScreen() {
  const router = useRouter();
  const live = useIsLive();
  return (
    <Screen edges={['top']}>
      <T variant="title" accessibilityRole="header">
        Menu
      </T>
      <Button label="Edit preferences" kind="secondary" disabled={!live} onPress={() => router.push('/edit-preferences')} />
      <Button label="Connection diagnostics" kind="secondary" onPress={() => router.push('/diagnostics')} />
    </Screen>
  );
}
