import { Injectable } from "@nestjs/common";
import {
  acceptJob,
  approvePairing,
  cancelJob,
  denyPairing,
  deviceHeartbeat,
  deviceHello,
  deviceStream,
  exchangeAssertion,
  finishJob,
  issueJobs,
  jobEvents,
  listDevices,
  markJobLost,
  parseLastEventId,
  peekPairing,
  pollPairing,
  recordJobEvents,
  rejectJob,
  revokeDevice,
  runBranches,
  runOnDevice,
  startPairing,
  sweepDeviceJobs,
  updateDevice,
} from "../../lib/daemon";

/**
 * What the daemon area can do, as the one door to it: the controllers (and, later, other modules through this module's index.ts)
 * call this, never lib/daemon.ts directly. For now each method hands over to the function in src/lib/daemon.ts with
 * the same arguments and answer; the logic moves in here area by area (docs/nest-architecture.md).
 */
@Injectable()
export class DaemonService {
  // ── the paired machine's side (/api/daemon) ──
  startPairing(...a: Parameters<typeof startPairing>) {
    return startPairing(...a);
  }
  pollPairing(...a: Parameters<typeof pollPairing>) {
    return pollPairing(...a);
  }
  exchangeAssertion(...a: Parameters<typeof exchangeAssertion>) {
    return exchangeAssertion(...a);
  }
  stream(...a: Parameters<typeof deviceStream>) {
    return deviceStream(...a);
  }
  parseLastEventId(...a: Parameters<typeof parseLastEventId>) {
    return parseLastEventId(...a);
  }
  hello(...a: Parameters<typeof deviceHello>) {
    return deviceHello(...a);
  }
  heartbeat(...a: Parameters<typeof deviceHeartbeat>) {
    return deviceHeartbeat(...a);
  }
  acceptJob(...a: Parameters<typeof acceptJob>) {
    return acceptJob(...a);
  }
  rejectJob(...a: Parameters<typeof rejectJob>) {
    return rejectJob(...a);
  }
  recordJobEvents(...a: Parameters<typeof recordJobEvents>) {
    return recordJobEvents(...a);
  }
  finishJob(...a: Parameters<typeof finishJob>) {
    return finishJob(...a);
  }
  /** Offers nobody took expire; jobs on a device that went quiet become unreachable. Run by DaemonSweep. */
  sweep(...a: Parameters<typeof sweepDeviceJobs>) {
    return sweepDeviceJobs(...a);
  }

  // ── a person's side (/api/app): their machines, and running an issue on one ──
  listDevices(...a: Parameters<typeof listDevices>) {
    return listDevices(...a);
  }
  peekPairing(...a: Parameters<typeof peekPairing>) {
    return peekPairing(...a);
  }
  approvePairing(...a: Parameters<typeof approvePairing>) {
    return approvePairing(...a);
  }
  denyPairing(...a: Parameters<typeof denyPairing>) {
    return denyPairing(...a);
  }
  updateDevice(...a: Parameters<typeof updateDevice>) {
    return updateDevice(...a);
  }
  revokeDevice(...a: Parameters<typeof revokeDevice>) {
    return revokeDevice(...a);
  }
  issueJobs(...a: Parameters<typeof issueJobs>) {
    return issueJobs(...a);
  }
  runBranches(...a: Parameters<typeof runBranches>) {
    return runBranches(...a);
  }
  runOnDevice(...a: Parameters<typeof runOnDevice>) {
    return runOnDevice(...a);
  }
  jobEvents(...a: Parameters<typeof jobEvents>) {
    return jobEvents(...a);
  }
  cancelJob(...a: Parameters<typeof cancelJob>) {
    return cancelJob(...a);
  }
  markJobLost(...a: Parameters<typeof markJobLost>) {
    return markJobLost(...a);
  }
}
