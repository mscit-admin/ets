// Line icons of the web UI (frontend/src/lib/iconPaths.js, shared) drawn with react-native-svg: 24 × 24, stroke
// 1.7, round caps and joins, the colour of the context. <IconShapes> draws the same inside another <Svg> (wheel).
import { memo, type ComponentType } from 'react';
import { type ColorValue, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Circle, Ellipse, G, Line, Path, Polygon, Polyline, Rect } from 'react-native-svg';
import { iconElements, type IconElement } from '@/lib/iconElements';
import { colors } from '@/theme';

const SHAPES = { path: Path, circle: Circle, rect: Rect, ellipse: Ellipse, line: Line, polyline: Polyline, polygon: Polygon };

function Shape({ el }: { el: IconElement }) {
  const C = SHAPES[el.tag] as unknown as ComponentType<Record<string, string>>;
  return <C {...el.attrs} />;
}

type Props = { name: string; size?: number; color?: ColorValue; flip?: boolean; style?: StyleProp<ViewStyle> };

export const Icon = memo(function Icon({ name, size = 16, color = colors.gray700, flip = false, style }: Props) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.7}
      strokeLinecap="round" strokeLinejoin="round" style={[flip ? { transform: [{ scaleX: -1 }] } : null, style]}
      accessible={false} importantForAccessibility="no-hide-descendants">
      {iconElements(name).map((el, i) => <Shape key={i} el={el} />)}
    </Svg>
  );
});

/** The icon's shapes inside an existing <Svg>, at (x, y) with the given size. */
export function IconShapes({ name, x, y, size, color }: { name: string; x: number; y: number; size: number; color: string }) {
  return (
    <G transform={`translate(${x} ${y}) scale(${size / 24})`} fill="none" stroke={color} strokeWidth={1.7}
      strokeLinecap="round" strokeLinejoin="round">
      {iconElements(name).map((el, i) => <Shape key={i} el={el} />)}
    </G>
  );
}
