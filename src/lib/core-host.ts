import { cache } from "react";
import { setRequestMemo } from "@wheelhouse/core/lib/metrics";

// A dashboard render calls several widgets that read the same team snapshot; React's cache() lets them share one query.
// Import this (for its effect) from any server module that calls the metrics functions.
setRequestMemo(cache);
