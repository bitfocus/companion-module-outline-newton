/** Maximum number of response bytes exposed through Companion variables or logs. */
export const RESPONSE_DIAGNOSTIC_PREFIX_BYTES = 256

/** Format a binary protocol reply without publishing an unbounded hex string. */
export function formatBufferDiagnostic(data: Buffer): string {
	const prefix = data.subarray(0, RESPONSE_DIAGNOSTIC_PREFIX_BYTES).toString('hex')
	return data.length > RESPONSE_DIAGNOSTIC_PREFIX_BYTES ? `${prefix}… (${data.length} bytes total)` : prefix
}

/** Format a structured protocol reply without publishing an unbounded JSON value. */
export function formatStructuredDiagnostic(value: unknown): string {
	let serialized: string
	try {
		serialized = JSON.stringify(value ?? {})
	} catch {
		return 'Unserializable response payload'
	}
	const encoded = Buffer.from(serialized, 'utf8')
	const prefix = encoded.subarray(0, RESPONSE_DIAGNOSTIC_PREFIX_BYTES).toString('utf8')
	return encoded.length > RESPONSE_DIAGNOSTIC_PREFIX_BYTES ? `${prefix}… (${encoded.length} bytes total)` : serialized
}
