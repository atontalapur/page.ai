import { useState, type ReactNode } from 'react';
import {
  LayoutDashboard,
  AlertTriangle,
  Bot,
  Activity,
  Settings,
  Bell,
  Sparkles,
} from 'lucide-react';

import {
  SidebarProvider,
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarInset,
  SidebarTrigger,
} from '@page/design-system/components/ui/sidebar';

import { Button } from '@page/design-system/components/ui/button';
import { Avatar, AvatarFallback } from '@page/design-system/components/ui/avatar';
import { Separator } from '@page/design-system/components/ui/separator';

type Page = 'Dashboard' | 'Incidents' | 'Agents' | 'Activity' | 'Settings';

interface DashboardLayoutProps {
  children: ReactNode;
}

const navigation = [
  { title: 'Dashboard', icon: LayoutDashboard },
  { title: 'Incidents', icon: AlertTriangle },
  { title: 'Agents', icon: Bot },
  { title: 'Activity', icon: Activity },
  { title: 'Settings', icon: Settings },
] as const;

export default function DashboardLayout({ children }: DashboardLayoutProps) {
  const [activePage, setActivePage] = useState<Page>('Dashboard');

  return (
    <SidebarProvider>
      <Sidebar collapsible="icon">
        <SidebarHeader className="p-4">
          <div className="flex items-center gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground">
              <Sparkles className="size-5" />
            </div>
            <span className="truncate text-xl font-bold group-data-[collapsible=icon]:hidden">
              Page.AI
            </span>
          </div>
        </SidebarHeader>

        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Workspace</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {navigation.map((item) => (
                  <SidebarMenuItem key={item.title}>
                    <SidebarMenuButton
                      tooltip={item.title}
                      isActive={item.title === 'Dashboard'}
                      disabled={item.title !== 'Dashboard'}
                    >
                      <item.icon className="size-4" />
                      <span>{item.title}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>

        <SidebarFooter className="p-4">
          <div className="flex items-center gap-3">
            <Avatar className="size-9">
              <AvatarFallback>JD</AvatarFallback>
            </Avatar>
            <div className="min-w-0 group-data-[collapsible=icon]:hidden">
              <p className="truncate text-sm font-medium">Demo User</p>
              <p className="text-xs text-muted-foreground">Workspace</p>
            </div>
          </div>
        </SidebarFooter>
      </Sidebar>

      <SidebarInset>
        <header className="flex h-16 shrink-0 items-center justify-between border-b px-4 md:px-6">
          <div className="flex items-center gap-3">
            <SidebarTrigger />
            <Separator orientation="vertical" className="h-5" />
            <h1 className="text-lg font-semibold">{activePage}</h1>
          </div>

          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" aria-label="Notifications" disabled>
              <Bell className="size-5" />
            </Button>
            <Avatar className="size-8">
              <AvatarFallback>JD</AvatarFallback>
            </Avatar>
          </div>
        </header>

        <div className="flex-1 bg-muted/20 p-4 md:p-6">
          <div className="mx-auto w-full max-w-7xl">{children}</div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
