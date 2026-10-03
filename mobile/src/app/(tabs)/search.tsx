import { Screen, T } from '@/ui/components';

export default function SearchScreen() {
  return (
    <Screen edges={['top']}>
      <T variant="title" accessibilityRole="header">
        Search
      </T>
    </Screen>
  );
}
