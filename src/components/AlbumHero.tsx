import { Text, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { workerApiClient } from '../services/api/WorkerApiClient';
import { heroHash, loadHero } from '../services/heroImage';

interface Props {
  name: string;
  photoCount: number;
  coverPhotoId: string;
  coverThumbnailUrl: string;
  /** Album owner: a missing hero is made from the original and uploaded. */
  canCreate: boolean;
}

/** The album cover as a banner with the album name; the blurred thumbnail stands in until (or unless) the hero loads. */
const AlbumHero = ({ name, photoCount, coverPhotoId, coverThumbnailUrl, canCreate }: Props) => {
  const hash = heroHash(coverThumbnailUrl);
  // Once per cover per page session (loadHero may download the original): never refetched, retried or dropped.
  const { data: heroUrl } = useQuery({
    queryKey: ['album-hero', hash],
    queryFn: () => loadHero(hash ?? '', coverPhotoId, canCreate),
    enabled: hash !== null,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
  const thumbnail = workerApiClient.thumbnailUrl({ thumbnailUrl: coverThumbnailUrl });

  return (
    <div className="pdx-hero">
      {/* Keyed by source, so a new cover never shows the old picture while it loads. */}
      <img key={thumbnail} className="pdx-hero-blur" src={thumbnail} alt="" />
      {heroUrl && <img key={heroUrl} className="pdx-hero-img" src={heroUrl} alt={`Cover photo of ${name}`} />}
      <div className="pdx-hero-text">
        <Title order={2} className="pdx-hero-name">
          {name}
        </Title>
        <Text>
          {photoCount} {photoCount === 1 ? 'photo' : 'photos'}
        </Text>
      </div>
    </div>
  );
};

export default AlbumHero;
