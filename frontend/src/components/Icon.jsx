import { ICON_PATHS } from '../lib/iconPaths.js';

export function Icon({ name, size = 16, className = "" }) {
  return (
    <svg className={"icon " + className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: (Object.hasOwn(ICON_PATHS, name) && ICON_PATHS[name]) || "" }} />
  );
}
