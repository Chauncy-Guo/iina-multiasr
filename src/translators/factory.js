/**
 * translators/factory.js ¡ª Create a translator instance by name.
 */

import { MiMoTranslator } from "./mimo.js";
import { DeepSeekTranslator } from "./deepseek.js";

const REGISTRY = {
    mimo: MiMoTranslator,
    deepseek: DeepSeekTranslator,
};

export function createTranslator(config) {
    const Cls = REGISTRY[config.provider];
    if (!Cls) {
        throw new Error(`Unknown translator provider: ${config.provider}`);
    }
    return new Cls(config);
}
