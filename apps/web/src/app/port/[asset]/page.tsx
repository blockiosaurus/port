import Dashboard from "./Dashboard";

export default async function Page({ params }: { params: Promise<{ asset: string }> }) {
  const { asset } = await params;
  return <Dashboard asset={asset} />;
}
