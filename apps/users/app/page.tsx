import { getDbPool } from '@knative-next/lib';
import { revalidatePath } from 'next/cache';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Button } from '@knative-next/ui';

export const dynamic = 'force-dynamic';

async function getUsers() {
  const db = getDbPool();
  const res = await db.query('SELECT * FROM users ORDER BY created_at DESC');
  return res.rows;
}

async function addUser(formData: FormData) {
  'use server';
  const name = formData.get('name') as string;
  const email = formData.get('email') as string;

  if (!name || !email) return;

  const db = getDbPool();
  await db.query('INSERT INTO users (name, email) VALUES ($1, $2)', [name, email]);
  revalidatePath('/users');
}

export default async function UsersPage() {
  const users = await getUsers();

  return (
    <div className="p-8 text-white">
      <h1 className="text-3xl font-bold mb-8">User Management</h1>

      <div className="grid md:grid-cols-3 gap-8">
        <div className="md:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Users</CardTitle>
              <CardDescription>Manage system users</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead className="border-b">
                    <tr>
                      <th className="p-4">Name</th>
                      <th className="p-4">Email</th>
                      <th className="p-4">Role</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((user: any) => (
                      <tr key={user.id} className="border-b border-white/10">
                        <td className="p-4">{user.name}</td>
                        <td className="p-4">{user.email}</td>
                        <td className="p-4">
                          <span className="px-2 py-1 rounded bg-purple-500/20 text-purple-200 text-sm">
                            {user.role}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </div>

        <div>
          <Card>
            <CardHeader>
              <CardTitle>Add User</CardTitle>
              <CardDescription>Create a new user</CardDescription>
            </CardHeader>
            <CardContent>
              <form action={addUser} className="space-y-4">
                <div>
                  <label className="block text-sm mb-1">Name</label>
                  <input
                    name="name"
                    type="text"
                    className="w-full p-2 rounded bg-black/20 border border-white/10"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm mb-1">Email</label>
                  <input
                    name="email"
                    type="email"
                    className="w-full p-2 rounded bg-black/20 border border-white/10"
                    required
                  />
                </div>
                <Button type="submit" className="w-full">
                  Add User
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

