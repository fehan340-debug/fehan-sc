// Five-minute technical/live-price updates are owned exclusively by the
// GitHub Actions Massive workflow. Keeping this Netlify function without a
// schedule prevents the daily Stock Split lane from being mixed into the
// Massive five-minute pipeline.
export default async function(){
  return new Response('Massive GitHub workflow owns the five-minute technical/live-price pipeline.',{status:200});
}
