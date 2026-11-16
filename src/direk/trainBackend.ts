/**
 * The training backend factory.
 *
 * `TRAIN_BACKEND` picks the backend and defaults to `local`, so an existing
 * install keeps running kohya_ss exactly as before. `colab` hands the run to a
 * Colab notebook through a Drive folder.
 *
 * This lives in its own module so `trainer.ts` (local) and `colabTrainer.ts`
 * (remote) never import each other.
 */

import { LocalTrainBackend, trainBackendName, type TrainBackend } from './trainer.ts';
import { ColabTrainBackend, type ColabBackendDeps } from './colabTrainer.ts';

/** Build the backend named by `TRAIN_BACKEND` (default `local`). */
export function createTrainBackend(deps: ColabBackendDeps = {}): TrainBackend {
  return trainBackendName() === 'colab' ? new ColabTrainBackend(deps) : new LocalTrainBackend();
}

export { trainBackendName };
export type { TrainBackend };
