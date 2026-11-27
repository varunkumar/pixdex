import { Center, Loader } from '@mantine/core';

/** The one "still loading" state for a page or a list. `label` says what is loading. */
const PageLoading = ({ label }: { label: string }) => (
  <Center py="xl">
    <Loader role="progressbar" aria-label={label} />
  </Center>
);

export default PageLoading;
