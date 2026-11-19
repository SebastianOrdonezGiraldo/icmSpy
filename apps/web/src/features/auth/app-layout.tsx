import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

export function AppLayout() {
  const navigate = useNavigate();
  const { data: session } = authClient.useSession();

  async function signOut() {
    await authClient.signOut();
    await navigate({ to: "/login" });
  }

  return (
    <div className="min-h-screen">
      <header className="border-b">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
          <nav className="flex items-center gap-4">
            <Link to="/" className="font-semibold">
              icmSpy
            </Link>
            <Link
              to="/instagram"
              className="text-sm text-muted-foreground hover:text-foreground"
              activeProps={{ className: "text-foreground font-medium" }}
            >
              Piloto Instagram
            </Link>
          </nav>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-muted-foreground">{session?.user.name}</span>
            <Button variant="outline" size="sm" onClick={signOut}>
              Salir
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
