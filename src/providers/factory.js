/**
 * providers/factory.js ?? Create an ASR provider instance by name.
 */

import { MiMoASRProvider } from "./mimo.js";
import { DoubaoASRProvider } from "./doubao.js";

const REGISTRY = {
    mimo: MiMoASRProvider,
    doubao: DoubaoASRProvider,
};

export function createASRProvider(config) {
    const Cls = REGISTRY[config.provider];
    if (!Cls) {
        throw new Error(`Unknown ASR provider: ${config.provider}`);
    }
    return new Cls(config);
}
