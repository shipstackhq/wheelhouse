import { createContext, useContext } from "react";

/**
 * Which team the dashboard widgets are showing, by key; null is the whole workspace (the home page). Every widget reads its
 * data through `useWidget`, which asks for this scope, so the same widgets draw the workspace page and a team's Overview.
 */
const DashboardScope = createContext<string | null>(null);
export const DashboardScopeProvider = DashboardScope.Provider;
export const useDashboardTeam = () => useContext(DashboardScope);
