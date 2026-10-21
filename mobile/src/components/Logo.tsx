// The organisation's logo: the image uploaded in Settings → Branding (GET /api/branding/logo, public), as on the
// web; without one, the built-in ETS mark (the web's public/favicon.svg, bundled).
import { useState } from 'react';
import { Image } from 'react-native';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { useSession } from '@/lib/session';

export function EtsMark({ size = 32 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 32 32" accessibilityRole="image" accessibilityLabel="ETS">
      <Rect width="32" height="32" rx="7" fill="#171717" />
      <Path d="M9 21.5V10.5h9M9 16h7M9 21.5h9" stroke="#fff" strokeWidth={2.6} fill="none" strokeLinecap="round" />
      <Circle cx="23" cy="21" r="2.2" fill="#2490ef" />
    </Svg>
  );
}

export function Logo({ height = 32 }: { height?: number }) {
  const { logoUrl } = useSession();
  const [failed, setFailed] = useState<string | null>(null);
  if (!logoUrl || failed === logoUrl) return <EtsMark size={height} />;
  return (
    <Image source={{ uri: logoUrl }} style={{ height, width: height * 4, maxWidth: '100%' }} resizeMode="contain"
      onError={() => setFailed(logoUrl)} accessibilityIgnoresInvertColors accessible={false} />
  );
}
