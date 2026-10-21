// Progress ring of the application header (web: PctEquation.jsx EqRing): pale track and arc in the continuous
// tone of the percentage (pctTone), the number in the middle.
import { StyleSheet, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { colors } from '@/theme';
import { toneOf } from '@/theme/tone';
import { Txt, pctText } from './ui';

/** Length of the arc for a value on a ring of radius r: [dash, gap] for strokeDasharray. */
export const ringDash = (value: number, r: number): [number, number] => {
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(100, +value || 0));
  return [(c * v) / 100, c];
};

export function Ring({ value, size, stroke, big = false }: { value: number; size: number; stroke: number; big?: boolean }) {
  const r = (size - stroke) / 2;
  const v = Math.max(0, Math.min(100, +value || 0));
  const tone = toneOf(v);
  const [dash, gap] = ringDash(v, r);
  const c = size / 2;
  return (
    <View style={{ width: size, height: size }} accessibilityRole="image" accessibilityLabel={pctText(v)}>
      <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <Circle cx={c} cy={c} r={r} fill="none" stroke={tone.bg} strokeWidth={stroke} />
        {v > 0 && (
          <Circle cx={c} cy={c} r={r} fill="none" stroke={tone.stroke} strokeWidth={stroke} strokeLinecap="round"
            strokeDasharray={`${dash} ${gap}`} transform={`rotate(-90 ${c} ${c})`} />
        )}
      </Svg>
      <View style={[StyleSheet.absoluteFill, styles.center]} pointerEvents="none">
        <Txt w={big ? 800 : 700} size={Math.round(size * (big ? 0.2 : 0.19))} color={big ? tone.text : colors.text} center>
          {pctText(v)}
        </Txt>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({ center: { alignItems: 'center', justifyContent: 'center' } });
