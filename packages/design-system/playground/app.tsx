import { Alert, AlertDescription, AlertTitle } from '@page/design-system/components/ui/alert';
import { Badge } from '@page/design-system/components/ui/badge';
import { Button } from '@page/design-system/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@page/design-system/components/ui/card';
import { Checkbox } from '@page/design-system/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@page/design-system/components/ui/dialog';
import { Input } from '@page/design-system/components/ui/input';
import { Label } from '@page/design-system/components/ui/label';
import { Progress } from '@page/design-system/components/ui/progress';
import { Slider } from '@page/design-system/components/ui/slider';
import { Switch } from '@page/design-system/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@page/design-system/components/ui/tabs';
import { useTheme } from '@page/design-system/components/theme-provider';

const steps = Array.from({ length: 12 }, (_, i) => i + 1);
const scales = ['slate', 'indigo', 'red'] as const;

function Swatches() {
  return (
    <div className="grid gap-1">
      {scales.map((scale) => (
        <div key={scale} className="grid grid-cols-[4rem_repeat(12,1fr)] items-center gap-1">
          <span className="text-xs text-muted-foreground">{scale}</span>
          {steps.map((step) => (
            <div
              key={step}
              title={`--${scale}-${step}`}
              className="h-8 rounded-sm"
              style={{ background: `var(--${scale}-${step})` }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export function App() {
  const { theme, setTheme } = useTheme();

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-8 p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-medium">Design system</h1>
        <Button variant="outline" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
          Toggle theme
        </Button>
      </header>

      <Swatches />

      <section className="flex flex-wrap gap-2">
        <Button>Primary</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="outline">Outline</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="destructive">Delete</Button>
        <Button variant="link">Link</Button>
      </section>

      <section className="flex flex-wrap gap-2">
        <Badge>Default</Badge>
        <Badge variant="secondary">Secondary</Badge>
        <Badge variant="outline">Outline</Badge>
        <Badge variant="destructive">Destructive</Badge>
      </section>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Create issue</CardTitle>
            <CardDescription>Assign it to the on-call agent.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid gap-2">
              <Label htmlFor="title">Title</Label>
              <Input id="title" placeholder="Checkout returns 500" />
            </div>
            <Label className="flex items-center gap-2">
              <Checkbox defaultChecked /> Notify the team
            </Label>
            <Label className="flex items-center gap-2">
              <Switch defaultChecked /> Auto-triage
            </Label>
            <Slider defaultValue={[40]} />
            <Progress value={64} />
          </CardContent>
          <CardFooter className="justify-end gap-2">
            <Dialog>
              <DialogTrigger render={<Button variant="outline" />}>Preview</DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Preview</DialogTitle>
                  <DialogDescription>The overlay uses Radix black-a5.</DialogDescription>
                </DialogHeader>
                <DialogFooter showCloseButton />
              </DialogContent>
            </Dialog>
            <Button>Create</Button>
          </CardFooter>
        </Card>

        <div className="flex flex-col gap-4">
          <Tabs defaultValue="live">
            <TabsList>
              <TabsTrigger value="live">Live</TabsTrigger>
              <TabsTrigger value="resolved">Resolved</TabsTrigger>
            </TabsList>
            <TabsContent value="live" className="text-sm text-muted-foreground">
              3 issues open.
            </TabsContent>
            <TabsContent value="resolved" className="text-sm text-muted-foreground">
              12 issues closed this week.
            </TabsContent>
          </Tabs>
          <Alert>
            <AlertTitle>Deploy finished</AlertTitle>
            <AlertDescription>All checks passed.</AlertDescription>
          </Alert>
          <Alert variant="destructive">
            <AlertTitle>Migration failed</AlertTitle>
            <AlertDescription>Column users.email already exists.</AlertDescription>
          </Alert>
        </div>
      </div>
    </main>
  );
}
