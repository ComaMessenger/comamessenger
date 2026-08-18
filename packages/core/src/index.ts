export type ServiceHealth = {
  status: "checking" | "ok" | "unavailable";
};

export async function getHealth(apiURL: string): Promise<ServiceHealth> {
  try {
    const response = await fetch(`${apiURL}/healthz`);
    return { status: response.ok ? "ok" : "unavailable" };
  } catch {
    return { status: "unavailable" };
  }
}
