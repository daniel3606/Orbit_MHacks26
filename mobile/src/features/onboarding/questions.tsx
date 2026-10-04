import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { useDraft, type Draft } from '@/state/onboarding-draft';
import { OptionCard, T } from '@/ui/components';
import { signLabel } from '@/ui/Constellation';
import { Dropdown } from '@/ui/Dropdown';
import { ListCard } from '@/ui/ListCard';
import { colors, font, HIT, space } from '@/ui/theme';
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

/**
 * One question. Onboarding shows it full size with option cards; `compact`
 * (Edit preferences) groups the options as rows on a list card.
 */
export function QuestionBlock({ question, compact }: { question: Question; compact?: boolean }) {
  if (compact) {
    return (
      <View style={styles.section} accessibilityRole={question.kind === 'options' && !question.multi ? 'radiogroup' : undefined}>
        <View style={styles.sectionHead}>
          <Text style={styles.sectionTitle} accessibilityRole="header">
            {question.title}
          </Text>
          {question.help ? <Text style={styles.sectionHelp}>{question.help}</Text> : null}
        </View>
        {question.kind === 'birthday' ? <BirthdayFields /> : <OptionList question={question} compact />}
      </View>
    );
  }
  return (
    <View style={styles.block} accessibilityRole={question.kind === 'options' && !question.multi ? 'radiogroup' : undefined}>
      <View style={styles.blockHead}>
        <Text style={styles.blockTitle} accessibilityRole="header" maxFontSizeMultiplier={1.3}>
          {question.title}
        </Text>
        {question.help ? (
          <Text style={styles.blockHelp} maxFontSizeMultiplier={1.4}>
            {question.help}
          </Text>
        ) : null}
      </View>
      {question.kind === 'birthday' ? <BirthdayFields /> : <OptionList question={question} />}
    </View>
  );
}

function OptionList({ question, compact }: { question: OptionQuestion; compact?: boolean }) {
  const value = useDraft(s => s.draft[question.key]);
  const set = useDraft(s => s.set);
  const toggleSector = useDraft(s => s.toggleSector);
  const isSelected = (option: Option) =>
    question.multi ? (value as string[]).includes(option.value) : value === option.value;
  const choose = (option: Option) => {
    if (question.multi) toggleSector(option.value);
    else set(question.key, option.value as never);
  };

  if (compact) {
    return (
      <ListCard>
        {question.options.map(option => (
          <ChoiceRow
            key={option.value}
            option={option}
            multi={question.multi}
            selected={isSelected(option)}
            onPress={() => choose(option)}
          />
        ))}
      </ListCard>
    );
  }

  return (
    <View style={{ gap: space.sm }}>
      {question.options.map(option => (
        <OptionCard
          key={option.value}
          title={option.label}
          description={option.description}
          multi={question.multi}
          selected={isSelected(option)}
          onPress={() => choose(option)}
        />
      ))}
    </View>
  );
}

/** An option as a list row, with a radio or checkbox on the right. */
function ChoiceRow({
  option,
  multi,
  selected,
  onPress,
}: {
  option: Option;
  multi?: boolean;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole={multi ? 'checkbox' : 'radio'}
      accessibilityState={multi ? { checked: selected } : { selected }}
      accessibilityLabel={option.description ? `${option.label}. ${option.description}` : option.label}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && { opacity: 0.62 }]}>
      <View style={styles.rowText}>
        <Text style={[styles.rowTitle, !selected && { color: colors.textMuted }]}>{option.label}</Text>
        {option.description ? <Text style={styles.rowDetail}>{option.description}</Text> : null}
      </View>
      {multi ? (
        <View style={[styles.marker, styles.box, selected && styles.boxOn]}>
          {selected ? (
            <Svg width={12} height={10} viewBox="0 0 12 10">
              <Path d="M1 5l3.5 3.5L11 1.5" stroke={colors.background} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </Svg>
          ) : null}
        </View>
      ) : (
        <View style={[styles.marker, styles.radio, selected && styles.markerOn]}>
          {selected ? <View style={styles.dot} /> : null}
        </View>
      )}
    </Pressable>
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

const styles = StyleSheet.create({
  block: { gap: space.xl },
  blockHead: { gap: space.sm },
  blockTitle: {
    fontFamily: font.semibold,
    fontSize: 26,
    lineHeight: 32,
    color: colors.text,
    letterSpacing: -0.4,
  },
  blockHelp: { fontFamily: font.regular, fontSize: 15, lineHeight: 21, color: colors.textMuted },
  section: { gap: space.md },
  sectionHead: { gap: 2 },
  sectionTitle: { fontFamily: font.semibold, fontSize: 18, lineHeight: 24, color: colors.text },
  sectionHelp: { fontFamily: font.regular, fontSize: 13, lineHeight: 18, color: colors.textMuted },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.lg, minHeight: HIT },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { fontFamily: font.semibold, fontSize: 16, lineHeight: 21, color: colors.text },
  rowDetail: { fontFamily: font.regular, fontSize: 13, lineHeight: 17, color: colors.textMuted },
  marker: { width: 22, height: 22, borderWidth: 1.5, borderColor: colors.textSubtle, alignItems: 'center', justifyContent: 'center' },
  radio: { borderRadius: 11 },
  markerOn: { borderColor: colors.text },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.text },
  box: { borderRadius: 6 },
  boxOn: { borderColor: colors.text, backgroundColor: colors.text },
});
