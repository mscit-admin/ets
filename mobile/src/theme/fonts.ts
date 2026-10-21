// Cairo, the web UI's font (@fontsource/cairo there), bundled with the app from @expo-google-fonts/cairo (exact
// version in package.json): the TTF files are part of the app, nothing is downloaded at run time.
// React Native picks a custom font by family name, so each weight is its own family (fontWeight is not used).
import {
  Cairo_400Regular, Cairo_500Medium, Cairo_600SemiBold, Cairo_700Bold, Cairo_800ExtraBold,
} from '@expo-google-fonts/cairo';

export const fontFiles = { Cairo_400Regular, Cairo_500Medium, Cairo_600SemiBold, Cairo_700Bold, Cairo_800ExtraBold };

export type Weight = 400 | 500 | 600 | 700 | 800;
const FAMILY: Record<Weight, keyof typeof fontFiles> = {
  400: 'Cairo_400Regular', 500: 'Cairo_500Medium', 600: 'Cairo_600SemiBold', 700: 'Cairo_700Bold', 800: 'Cairo_800ExtraBold',
};

/** Style for text of a weight: { fontFamily } */
export const font = (w: Weight = 400) => ({ fontFamily: FAMILY[w] });
export const fontFamily = (w: Weight = 400) => FAMILY[w];
