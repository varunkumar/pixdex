import { Text, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { workerApiClient } from '../services/api/WorkerApiClient';
import { heroHash, loadHero } from '../services/heroImage';

interface Props {
  name: string;
  photoCount: number;
  coverPhotoId: string;
  coverThumbnailUrl: string;
}

/** The album cover as a banner with the album name; the blurred thumbnail stands in until (or unless) the hero loads. */
const AlbumHero = ({ name, photoCount, coverPhotoId, coverThumbnailUrl }: Props) => {
  const hash = heroHash(coverThumbnailUrl);
  // Once per visit: never refetched or retried while on screen, and dropped on leaving, so the next visit asks
  // again (an unavailable original is retried then) and the image is not held in memory meanwhile.
  const { data: image } = useQuery({
    queryKey: ['album-hero', name, hash],
    queryFn: () => loadHero(name, hash ?? '', coverPhotoId),
    enabled: hash !== null,
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });
  // An image that will not show is hidden; remembered by blob, so another cover's hero still shows.
  const [failedImage, setFailedImage] = useState<Blob | null>(null);
  // The object URL lives exactly as long as the <img> showing this blob.
  const showImage = useCallback(
    (element: HTMLImageElement | null) => {
      if (!element || !image) return;
      const url = URL.createObjectURL(image);
      element.src = url;
      return () => URL.revokeObjectURL(url);
    },
    [image]
  );
  const thumbnail = workerApiClient.thumbnailUrl({ thumbnailUrl: coverThumbnailUrl });

  return (
    <div className="pdx-hero">
      {/* Keyed by source, so a new cover never shows the old picture while it loads. */}
      <img key={thumbnail} className="pdx-hero-blur" src={thumbnail} alt="" />
      {image && image !== failedImage && (
        <img
          key={hash}
          ref={showImage}
          className="pdx-hero-img"
          alt={`Cover photo of ${name}`}
          onError={() => setFailedImage(image)}
        />
      )}
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
