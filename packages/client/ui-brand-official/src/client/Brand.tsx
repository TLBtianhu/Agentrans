import type { SidebarBrandMarkOwnerProps } from '@agentrans/client-ui-sidebar/client'

/**
 * The product wordmark. A brand name is a trademark rather than localized copy,
 * so every locale shows the same spelling.
 */
const PRODUCT_NAME = 'Agentrans'

/**
 * Render the Agentrans mark with the presentation requested by its host surface.
 * @param props - Host-supplied mark presentation.
 * @returns the Agentrans mark.
 */
export function OfficialBrandMark({ size }: SidebarBrandMarkOwnerProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path d="M8 21 C8 13 13 8 20 8 C25 8 29 12 29 18 C29 20 27 22 25 22 C23 22 22 20 20 20 C17 20 15 22 15 25"
        stroke="#0F766E" strokeWidth="3.4" strokeLinecap="round" />
      <rect x="23.6" y="6.6" width="6.4" height="6.4" rx="1.4" transform="rotate(45 26.8 9.8)" fill="#F59E0B" />
    </svg>
  )
}

/**
 * Render the Agentrans name artwork without its independently slotted mark.
 * @returns the Agentrans wordmark.
 */
export function OfficialBrandName() {
  return (
    <span
      aria-hidden="true"
      style={{
        fontFamily: 'Montserrat, ui-sans-serif, system-ui, sans-serif',
        fontSize: 18,
        fontWeight: 600,
        letterSpacing: '0.01em',
        color: 'currentColor',
        lineHeight: 1,
        whiteSpace: 'nowrap',
      }}
    >
      {PRODUCT_NAME}
    </span>
  )
}
