// A switch in the web UI's colours (dark when on). On the web preview react-native-web draws the thumb from the left
// whatever the direction, so there it is kept left-to-right; the phone's native switch mirrors itself in Arabic.
import { Platform, StyleSheet, Switch, View, type SwitchProps } from 'react-native';
import { colors } from '@/theme';

export function Toggle(props: SwitchProps) {
  const sw = <Switch trackColor={{ true: colors.gray800, false: colors.gray300 }} thumbColor={colors.white} {...props} />;
  return Platform.OS === 'web' ? <View style={st.ltr}>{sw}</View> : sw;
}

const st = StyleSheet.create({ ltr: { direction: 'ltr' } });
