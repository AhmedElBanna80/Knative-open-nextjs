import { Card, CardContent, CardDescription, CardHeader, CardTitle, Button } from '@knative-next/ui';
import Link from 'next/link';

export default function HomePage() {
  return (
    <div className="container mx-auto p-8">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-5xl font-bold text-white mb-4">Welcome to File Manager</h1>
        <p className="text-xl text-purple-200 mb-12">
          A modern file management system built with Next.js Multi-Zone architecture
        </p>

        <div className="grid md:grid-cols-2 gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Dashboard</CardTitle>
              <CardDescription>View system statistics and recent activity</CardDescription>
            </CardHeader>
            <CardContent>
              <Link href="/dashboard">
                <Button className="w-full">Go to Dashboard</Button>
              </Link>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Users</CardTitle>
              <CardDescription>Manage system users and permissions</CardDescription>
            </CardHeader>
            <CardContent>
              <Link href="/users">
                <Button className="w-full">Manage Users</Button>
              </Link>
            </CardContent>
          </Card>
        </div>

        <Card className="mt-8">
          <CardHeader>
            <CardTitle>Multi-Zone Architecture</CardTitle>
            <CardDescription>Benefits of the new architecture</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm">
              <li>✓ Parallel builds with Turborepo</li>
              <li>✓ Faster development with Turbopack</li>
              <li>✓ Independent deployment of zones</li>
              <li>✓ Shared UI components with shadcn/ui</li>
              <li>✓ Improved scalability and maintainability</li>
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

