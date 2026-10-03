import { Screen, T } from '@/ui/components';

export default function MenuScreen() {
  return (
    <Screen edges={['top']}>
      <T variant="title" accessibilityRole="header">
        Menu
      </T>
    </Screen>
  );
}
