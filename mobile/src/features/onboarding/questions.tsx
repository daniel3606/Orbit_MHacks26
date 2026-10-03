import { View } from 'react-native';

import { useDraft, type Draft } from '@/state/onboarding-draft';
import { OptionCard, T } from '@/ui/components';
import { space } from '@/ui/theme';
import {
  EXPERIENCE_LEVEL,
  INVESTMENT_HORIZON,
  INVESTMENT_STYLE,
  MAX_SECTORS,
  PRIMARY_GOAL,
  RISK_TOLERANCE,
  SECTORS,
  ZODIAC_SIGNS,
  type Option,
} from './options';

export type Question = {
  key: keyof Draft;
  title: string;
  help?: string;
  options: Option[];
  multi?: boolean;
  optional?: boolean;
};

export const QUESTIONS: Question[] = [
  {
    key: 'riskTolerance',
    title: 'How do you feel about ups and downs?',
    help: 'Stock prices move. This sets which companies Orbit will consider for you.',
    options: RISK_TOLERANCE,
  },
  { key: 'investmentHorizon', title: 'How long are you thinking?', options: INVESTMENT_HORIZON },
  { key: 'investmentStyle', title: 'Which style interests you most?', options: INVESTMENT_STYLE },
  {
    key: 'sectorInterests',
    title: 'Which areas interest you?',
    help: `Pick 1 to ${MAX_SECTORS}.`,
    options: SECTORS,
    multi: true,
  },
  { key: 'experienceLevel', title: 'How much investing experience do you have?', options: EXPERIENCE_LEVEL },
  { key: 'primaryGoal', title: 'What do you most want from Orbit?', options: PRIMARY_GOAL },
  {
    key: 'zodiacSign',
    title: 'Choose your sign (optional)',
    help: 'Just for the look of your Orbit. It never affects which stocks you see or how they are scored.',
    options: ZODIAC_SIGNS,
    optional: true,
  },
];

export function QuestionBlock({ question, compact }: { question: Question; compact?: boolean }) {
  const value = useDraft(s => s.draft[question.key]);
  const set = useDraft(s => s.set);
  const toggleSector = useDraft(s => s.toggleSector);

  return (
    <View style={{ gap: space.md }} accessibilityRole={question.multi ? undefined : 'radiogroup'}>
      <T variant={compact ? 'heading' : 'title'} accessibilityRole="header">
        {question.title}
      </T>
      {question.help ? <T muted>{question.help}</T> : null}
      <View style={{ gap: space.sm }}>
        {question.options.map(option => {
          const selected = question.multi
            ? (value as string[]).includes(option.value)
            : value === option.value;
          return (
            <OptionCard
              key={option.value}
              title={option.label}
              description={option.description}
              multi={question.multi}
              selected={selected}
              onPress={() => {
                if (question.multi) toggleSector(option.value);
                else if (question.optional && selected) set(question.key, null as never);
                else set(question.key, option.value as never);
              }}
            />
          );
        })}
      </View>
    </View>
  );
}

export function isAnswered(question: Question, draft: Draft): boolean {
  const v = draft[question.key];
  if (question.optional) return true;
  if (question.multi) return Array.isArray(v) && v.length >= 1 && v.length <= MAX_SECTORS;
  return typeof v === 'string' && v.length > 0;
}
