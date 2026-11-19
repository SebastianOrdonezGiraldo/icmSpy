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
import { InstagramPilotPage } from "./features/instagram-pilot/instagram-pilot-page";
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

const instagramRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/instagram",
  component: InstagramPilotPage,
  validateSearch: (search: Record<string, unknown>): { run?: string; demo?: string } => ({
    ...(typeof search.run === "string" && /^\d{8}T\d{6}Z-[a-z0-9._]{1,30}$/.test(search.run)
      ? { run: search.run }
      : {}),
    // Búsqueda de la demo con datos de prueba: queda en la URL para verla al recargar.
    ...(typeof search.demo === "string" && /^[0-9a-f-]{36}$/i.test(search.demo)
      ? { demo: search.demo }
      : {}),
  }),
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  appRoute.addChildren([companiesRoute, companyRoute, instagramRoute]),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
