import { type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';

import {
  BellIcon,
  BotIcon,
  DangerTriangleIcon,
  StarsIcon,
  WidgetIcon,
} from '@solar-icons/react/linear';

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

import ConnectionBadge from '../issues/ConnectionBadge';

interface DashboardLayoutProps {
  children: ReactNode;
}

const navigation = [
  { title: 'Dashboard', icon: WidgetIcon, path: '/' },
  { title: 'Incidents', icon: DangerTriangleIcon, path: '/incidents' },
  { title: 'Agents', icon: BotIcon, path: '/agents' },
] as const;

export default function DashboardLayout({ children }: DashboardLayoutProps) {
  const { pathname } = useLocation();

  const isActivePath = (path: string) =>
    pathname === path || (path !== '/' && pathname.startsWith(`${path}/`));

  const activePage = navigation.find((item) => isActivePath(item.path))?.title ?? 'Page.AI';

  return (
    <SidebarProvider>
      <Sidebar collapsible="icon">
        {/* Logo */}
        <SidebarHeader className="p-4">
          <div className="flex items-center gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-soft">
              <StarsIcon className="size-5" />
            </div>

            <span className="truncate text-lg font-semibold group-data-[collapsible=icon]:hidden">
              Page.AI
            </span>
          </div>
        </SidebarHeader>

        {/* Navigation */}
        <SidebarContent>
          <SidebarGroup className="px-3 py-4">
            <SidebarGroupLabel className="mb-2 px-3 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              Workspace
            </SidebarGroupLabel>

            <SidebarGroupContent>
              <SidebarMenu className="gap-1">
                {navigation.map((item) => {
                  const isActive = isActivePath(item.path);

                  return (
                    <SidebarMenuItem key={item.title}>
                      <SidebarMenuButton
                        tooltip={item.title}
                        isActive={isActive}
                        render={<NavLink to={item.path} />}
                        className="h-10 rounded-lg"
                      >
                        <item.icon />

                        <span className="text-sm font-medium">{item.title}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>

        {/* User Profile */}
        <SidebarFooter className="p-4">
          <div className="flex items-center gap-3">
            <Avatar className="size-9 shrink-0">
              <AvatarFallback>JD</AvatarFallback>
            </Avatar>

            <div className="min-w-0 group-data-[collapsible=icon]:hidden">
              <p className="truncate text-sm font-medium">Demo User</p>

              <p className="text-xs text-muted-foreground">Workspace</p>
            </div>
          </div>
        </SidebarFooter>
      </Sidebar>

      {/* Main Content */}
      {/* min-w-0 lets a wide table scroll inside its card instead of widening the page. */}
      <SidebarInset className="min-w-0">
        <header className="flex h-16 shrink-0 items-center justify-between px-4 md:px-8">
          <div className="flex items-center gap-3">
            <SidebarTrigger />

            <h1 className="text-base font-semibold text-balance">{activePage}</h1>
          </div>

          <div className="flex items-center gap-3">
            <ConnectionBadge />

            <Button variant="ghost" size="icon" aria-label="Notifications" disabled>
              <BellIcon className="size-5" />
            </Button>

            <Avatar className="size-8">
              <AvatarFallback>JD</AvatarFallback>
            </Avatar>
          </div>
        </header>

        <div className="flex-1 px-4 pt-2 pb-10 md:px-8">
          <div className="mx-auto w-full max-w-7xl">{children}</div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
