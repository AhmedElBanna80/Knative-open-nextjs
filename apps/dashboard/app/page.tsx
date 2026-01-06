import { getDbPool } from '@knative-next/lib';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@knative-next/ui';

export const dynamic = 'force-dynamic';

async function getStats() {
  const db = getDbPool();

  const fileStats = await db.query(
    'SELECT COUNT(*) as count, COALESCE(SUM(size), 0) as total_size FROM files',
  );
  const userStats = await db.query('SELECT COUNT(*) as count FROM users');
  const recentFiles = await db.query('SELECT * FROM files ORDER BY uploaded_at DESC LIMIT 5');

  return {
    fileCount: fileStats.rows[0].count,
    totalSize: fileStats.rows[0].total_size,
    userCount: userStats.rows[0].count,
    recentFiles: recentFiles.rows,
  };
}

export default async function DashboardPage() {
  const stats = await getStats();

  return (
    <div className="p-8 text-white">
      <h1 className="text-3xl font-bold mb-8">Dashboard</h1>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        <Card>
          <CardHeader>
            <CardTitle>Total Files</CardTitle>
            <CardDescription>Files in storage</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-4xl font-bold">{stats.fileCount}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Storage Used</CardTitle>
            <CardDescription>Total storage consumed</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-4xl font-bold">
              {(stats.totalSize / 1024 / 1024).toFixed(2)} MB
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Total Users</CardTitle>
            <CardDescription>Registered users</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-4xl font-bold">{stats.userCount}</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent Uploads</CardTitle>
          <CardDescription>Latest files uploaded to the system</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead className="border-b">
                <tr>
                  <th className="p-4">Name</th>
                  <th className="p-4">Size</th>
                  <th className="p-4">Date</th>
                </tr>
              </thead>
              <tbody>
                {stats.recentFiles.map((file: any) => (
                  <tr key={file.id} className="border-b border-white/10">
                    <td className="p-4">{file.name}</td>
                    <td className="p-4">{(file.size / 1024).toFixed(1)} KB</td>
                    <td className="p-4">{new Date(file.uploaded_at).toLocaleString()}</td>
                  </tr>
                ))}
                {stats.recentFiles.length === 0 && (
                  <tr>
                    <td colSpan={3} className="p-4 text-center text-gray-400">
                      No files uploaded yet
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

