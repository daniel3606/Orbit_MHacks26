import { View } from 'react-native';

import { useDraft, type Draft } from '@/state/onboarding-draft';
import { OptionCard, T } from '@/ui/components';
import { signLabel } from '@/ui/Constellation';
import { Dropdown } from '@/ui/Dropdown';
import { space } from '@/ui/theme';
import {
  EXPERIENCE_LEVEL,
  INVESTMENT_HORIZON,
  INVESTMENT_STYLE,
  MAX_SECTORS,
  PRIMARY_GOAL,
  RISK_TOLERANCE,
  SECTORS,
  type Option,
} from './options';
import { daysInMonth, MONTHS } from './zodiac';

type OptionQuestion = {
  kind: 'options';
  key: Exclude<keyof Draft, 'zodiacSign' | 'birthMonth' | 'birthDay'>;
  title: string;
  help?: string;
  options: Option[];
  multi?: boolean;
};

/** Asks for month and day; the draft keeps the sign worked out from them. */
type BirthdayQuestion = {
  kind: 'birthday';
  key: 'zodiacSign';
  title: string;
  help?: string;
};

export type Question = OptionQuestion | BirthdayQuestion;

export const QUESTIONS: Question[] = [
  {
    kind: 'options',
    key: 'riskTolerance',
    title: 'How do you feel about ups and downs?',
    help: 'Stock prices move. This sets which companies Orbit will consider for you.',
    options: RISK_TOLERANCE,
  },
  { kind: 'options', key: 'investmentHorizon', title: 'How long are you thinking?', options: INVESTMENT_HORIZON },
  { kind: 'options', key: 'investmentStyle', title: 'Which style interests you most?', options: INVESTMENT_STYLE },
  {
    kind: 'options',
    key: 'sectorInterests',
    title: 'Which areas interest you?',
    help: `Pick 1 to ${MAX_SECTORS}.`,
    options: SECTORS,
    multi: true,
  },
  { kind: 'options', key: 'experienceLevel', title: 'How much investing experience do you have?', options: EXPERIENCE_LEVEL },
  { kind: 'options', key: 'primaryGoal', title: 'What do you most want from Orbit?', options: PRIMARY_GOAL },
  // Last, so the next thing the user sees is their sign on the loading screen.
  {
    kind: 'birthday',
    key: 'zodiacSign',
    title: 'When’s your birthday?',
    help: 'Your star sign picks the part of the market Discover explores each day. It never affects how companies are scored. Orbit saves only your sign, not your birthday.',
  },
];

const MONTH_OPTIONS = MONTHS.map((label, i) => ({ value: i + 1, label }));

export function QuestionBlock({ question, compact }: { question: Question; compact?: boolean }) {
  return (
    <View style={{ gap: space.md }} accessibilityRole={question.kind === 'options' && !question.multi ? 'radiogroup' : undefined}>
      <T variant={compact ? 'heading' : 'title'} accessibilityRole="header">
        {question.title}
      </T>
      {question.help ? <T muted>{question.help}</T> : null}
      {question.kind === 'birthday' ? <BirthdayFields /> : <OptionList question={question} />}
    </View>
  );
}

function OptionList({ question }: { question: OptionQuestion }) {
  const value = useDraft(s => s.draft[question.key]);
  const set = useDraft(s => s.set);
  const toggleSector = useDraft(s => s.toggleSector);

  return (
    <View style={{ gap: space.sm }}>
      {question.options.map(option => {
        const selected = question.multi ? (value as string[]).includes(option.value) : value === option.value;
        return (
          <OptionCard
            key={option.value}
            title={option.label}
            description={option.description}
            multi={question.multi}
            selected={selected}
            onPress={() => {
              if (question.multi) toggleSector(option.value);
              else set(question.key, option.value as never);
            }}
          />
        );
      })}
    </View>
  );
}

function BirthdayFields() {
  const month = useDraft(s => s.draft.birthMonth);
  const day = useDraft(s => s.draft.birthDay);
  const sign = useDraft(s => s.draft.zodiacSign);
  const setBirthday = useDraft(s => s.setBirthday);
  const dayOptions = Array.from({ length: month ? daysInMonth(month) : 31 }, (_, i) => ({ value: i + 1, label: String(i + 1) }));
  const fromBirthday = month !== null && day !== null;

  return (
    <View style={{ gap: space.lg }}>
      <View style={{ flexDirection: 'row', gap: space.md }}>
        <View style={{ flex: 3 }}>
          <Dropdown label="Month" placeholder="Month" options={MONTH_OPTIONS} value={month} onChange={m => setBirthday({ month: m })} />
        </View>
        <View style={{ flex: 2 }}>
          <Dropdown label="Day" placeholder="Day" options={dayOptions} value={day} onChange={d => setBirthday({ day: d })} />
        </View>
      </View>
      {sign ? (
        <T variant="label" muted accessibilityRole="text">
          {fromBirthday ? `You’re ${/^[aeiou]/.test(sign) ? 'an' : 'a'} ${signLabel(sign)}.` : `Current sign: ${signLabel(sign)}`}
        </T>
      ) : null}
    </View>
  );
}

export function isAnswered(question: Question, draft: Draft): boolean {
  if (question.kind === 'birthday') return draft.birthMonth !== null && draft.birthDay !== null && draft.zodiacSign !== null;
  const v = draft[question.key];
  if (question.multi) return Array.isArray(v) && v.length >= 1 && v.length <= MAX_SECTORS;
  return typeof v === 'string' && v.length > 0;
}
