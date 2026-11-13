import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { AppLayout } from "./features/auth/app-layout";
import { LoginPage } from "./features/auth/login-page";
import { CompaniesPage } from "./features/companies/companies-page";
import { CompanyPage } from "./features/companies/company-page";
import { authClient } from "./lib/auth-client";

const rootRoute = createRootRoute({ component: Outlet });

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginPage,
});

/** Todo lo que cuelga de aquí exige sesión. */
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  component: AppLayout,
  beforeLoad: async () => {
    const { data } = await authClient.getSession();
    if (!data) throw redirect({ to: "/login" });
  },
});

const companiesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  component: CompaniesPage,
  // Ejecución de búsqueda que se muestra: sobrevive a la recarga y separa resultados entre búsquedas.
  validateSearch: (search: Record<string, unknown>): { run?: string } =>
    typeof search.run === "string" && /^[0-9a-f-]{36}$/i.test(search.run)
      ? { run: search.run }
      : {},
});

const companyRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/companies/$id",
  component: CompanyPage,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  appRoute.addChildren([companiesRoute, companyRoute]),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
