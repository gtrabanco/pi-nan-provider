/**
 * @gtrabanco/pi-nan-provider — NaN Builders provider for pi.
 *
 * Registers every provider in PROVIDERS via the shared OpenAI-compatible
 * factory. The registration is synchronous on purpose: the generated fallback
 * catalog is available immediately at startup, and pi's Models runtime calls
 * the provider's fetchModels (live /models × generated catalog) on its own
 * network refreshes, persisting the overlay between runs.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createNanCompatibleProvider } from "./provider-factory.ts";
import { PROVIDERS } from "./providers.ts";

export default function nanProviderExtension(pi: ExtensionAPI): void {
	for (const config of PROVIDERS) {
		pi.registerProvider(createNanCompatibleProvider(config));
	}
}
