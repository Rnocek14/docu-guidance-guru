import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { missionControlNavItems } from '@/components/layout/AdminNav';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { MoreHorizontal, Shield, UserPlus, AlertTriangle } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { Database } from '@/integrations/supabase/types';

type AppRole = Database['public']['Enums']['app_role'];

interface UserWithRoles {
  id: string;
  user_id: string;
  email: string;
  full_name: string | null;
  created_at: string;
  roles: AppRole[];
}

export default function UsersManagement() {
  const queryClient = useQueryClient();
  const [selectedUser, setSelectedUser] = useState<UserWithRoles | null>(null);
  const [roleDialogOpen, setRoleDialogOpen] = useState(false);
  const [newRole, setNewRole] = useState<AppRole | ''>('');

  // Fetch all users with their roles
  const { data: users, isLoading } = useQuery({
    queryKey: ['admin-users'],
    queryFn: async () => {
      // Get all profiles
      const { data: profiles, error: profilesError } = await supabase
        .from('profiles')
        .select('*')
        .order('created_at', { ascending: false });

      if (profilesError) throw profilesError;

      // Get all roles
      const { data: allRoles, error: rolesError } = await supabase
        .from('user_roles')
        .select('*');

      if (rolesError) throw rolesError;

      // Merge roles into profiles
      const usersWithRoles: UserWithRoles[] = profiles.map((profile) => ({
        id: profile.id,
        user_id: profile.user_id,
        email: profile.email,
        full_name: profile.full_name,
        created_at: profile.created_at,
        roles: allRoles
          .filter((r) => r.user_id === profile.user_id)
          .map((r) => r.role),
      }));

      return usersWithRoles;
    },
  });

  // Add role mutation
  const addRole = useMutation({
    mutationFn: async ({ userId, role }: { userId: string; role: AppRole }) => {
      const { error } = await supabase.from('user_roles').insert({
        user_id: userId,
        role: role,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      toast.success('Role added successfully');
      setRoleDialogOpen(false);
      setNewRole('');
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to add role');
    },
  });

  // Remove role mutation
  const removeRole = useMutation({
    mutationFn: async ({ userId, role }: { userId: string; role: AppRole }) => {
      const { error } = await supabase
        .from('user_roles')
        .delete()
        .eq('user_id', userId)
        .eq('role', role);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      toast.success('Role removed');
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to remove role');
    },
  });

  const getRoleBadgeVariant = (role: AppRole): 'default' | 'secondary' | 'destructive' | 'outline' => {
    switch (role) {
      case 'admin':
        return 'destructive';
      case 'risk_officer':
        return 'default';
      case 'support':
        return 'secondary';
      default:
        return 'outline';
    }
  };

  const availableRoles: AppRole[] = ['trader', 'risk_officer', 'support', 'admin'];

  return (
    <DashboardLayout title="User Management" navItems={missionControlNavItems}>
      <div className="space-y-6">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Users & Roles</h2>
          <p className="text-muted-foreground">
            Manage user accounts and role assignments.
          </p>
        </div>

        {/* Warning card */}
        <Card className="border-warning/50 bg-warning/5">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-warning text-base">
              <AlertTriangle className="h-4 w-4" />
              Role Assignment Warning
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            <p>Admin role grants full system access including terminal actions. Risk Officer can review accounts but cannot approve payouts.</p>
          </CardContent>
        </Card>

        {/* Users table */}
        <Card>
          <CardHeader>
            <CardTitle>All Users</CardTitle>
            <CardDescription>
              {users?.length || 0} registered users
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="text-center py-8 text-muted-foreground">Loading users...</div>
            ) : users && users.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>User</TableHead>
                    <TableHead>Roles</TableHead>
                    <TableHead>Joined</TableHead>
                    <TableHead className="w-[50px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {users.map((user) => (
                    <TableRow key={user.id}>
                      <TableCell>
                        <div>
                          <p className="font-medium">{user.full_name || 'No name'}</p>
                          <p className="text-sm text-muted-foreground">{user.email}</p>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {user.roles.length > 0 ? (
                            user.roles.map((role) => (
                              <Badge key={role} variant={getRoleBadgeVariant(role)}>
                                {role.replace('_', ' ')}
                              </Badge>
                            ))
                          ) : (
                            <span className="text-muted-foreground text-sm">No roles</span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {new Date(user.created_at).toLocaleDateString()}
                      </TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuLabel>Actions</DropdownMenuLabel>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={() => {
                                setSelectedUser(user);
                                setRoleDialogOpen(true);
                              }}
                            >
                              <UserPlus className="mr-2 h-4 w-4" />
                              Add Role
                            </DropdownMenuItem>
                            {user.roles.map((role) => (
                              <DropdownMenuItem
                                key={role}
                                onClick={() => removeRole.mutate({ userId: user.user_id, role })}
                                className="text-destructive"
                              >
                                <Shield className="mr-2 h-4 w-4" />
                                Remove {role.replace('_', ' ')}
                              </DropdownMenuItem>
                            ))}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <div className="text-center py-8 text-muted-foreground">
                No users found.
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Add Role Dialog */}
      <Dialog open={roleDialogOpen} onOpenChange={setRoleDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Role</DialogTitle>
            <DialogDescription>
              Assign a new role to {selectedUser?.full_name || selectedUser?.email}
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Select value={newRole} onValueChange={(v) => setNewRole(v as AppRole)}>
              <SelectTrigger>
                <SelectValue placeholder="Select a role" />
              </SelectTrigger>
              <SelectContent>
                {availableRoles
                  .filter((r) => !selectedUser?.roles.includes(r))
                  .map((role) => (
                    <SelectItem key={role} value={role}>
                      {role.replace('_', ' ')}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRoleDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (selectedUser && newRole) {
                  addRole.mutate({ userId: selectedUser.user_id, role: newRole });
                }
              }}
              disabled={!newRole || addRole.isPending}
            >
              Add Role
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
