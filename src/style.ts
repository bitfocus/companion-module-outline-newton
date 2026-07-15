import { combineRgb } from '@companion-module/base'

/**
 * Shared visual language for every preset button, so the module looks like
 * one product instead of a pile of defaults. Backgrounds are near-black with
 * a cold tint; state colors are saturated but not neon.
 */
export const UI = {
	/** Base background of informative buttons (monitors, labels). */
	bgNeutral: combineRgb(16, 18, 24),
	/** Slightly lifted background for pressable non-status buttons. */
	bgPanel: combineRgb(30, 34, 44),
	/** Healthy / open / online. */
	green: combineRgb(0, 150, 64),
	/** Backup engaged / attention. */
	orange: combineRgb(230, 115, 0),
	/** Muted / offline / alarm. */
	red: combineRgb(195, 30, 45),
	/** Action buttons (rearm). */
	blue: combineRgb(25, 80, 210),
	/** Snapshot actions. */
	indigo: combineRgb(75, 45, 150),
	textPrimary: combineRgb(255, 255, 255),
	textDim: combineRgb(150, 158, 170),
} as const
